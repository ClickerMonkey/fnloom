/**
 * The planner the agent loop calls before every LLM call. It picks the session's chat mode and contextor (the
 * session's override, else the agent payload's, else build 1's), measures the fixed part (the instructions with the
 * mode's guide, the mode's tools, the current exchange), trims the current exchange when even that doesn't fit (the
 * hub's blocks on the person's message first, then older tool results, then the newest one) or refuses with a plain
 * message, asks the contextor for a selection within what is left, renders it with the mode, and checks the request's
 * estimate against the budget. `maxTokens` and `contextWindow` go on every request. A session's system message lists,
 * after the instructions, the systems its first turn found available (`fixedRegion`), the same every step so it caches.
 *
 * The agent's injected section (`{{injectedContext}}`, `injected.ts`) is part of the fixed region: worked out once at
 * the start of a turn and kept for every step of it, counted in the fixed part, its items treated as loaded by every
 * contextor and their fns among the agent's starting tools. At each new turn it is worked out again, and the session's
 * `FixedRegionStamp` rewritten, only when the region's text changed (a system off, an approval, an admin's switch).
 */
import { plainDeferred } from '@aeye/schema';
import type { Logger } from '@ayepi/log';
import {
  ChatModeConfig, compositeKey, ContextorConfig, DEFAULT_CHAT_MODE, DEFAULT_CONTEXTOR, flow, mapConcurrent, ModelChoice, namesModel, QualifiedName, type ActorId, type RunId, type AnnouncedSystem, type Exposure, type InjectedReport, type FnBlock, type FnRecord, type FnRefusal, type LlmMessage, type ModelFnNames, type ModelInfo,
  type Json, type Session, type SessionId, type SelectionReport, type Turn, type TurnId,
} from '@harness/core';
import { LlmPayloadType, parseValue, type LlmPayload } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import type { ModelResolver } from '../execution/models.ts';
import { systemsNow, systemsPrompt } from '../chat/announce.ts';
import { citationsPrompt } from '../chat/cite-rule.ts';
import { MODE_RANK } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import { budgetPlan } from './budget.ts';
import { CONTEXTORS } from './contextors.ts';
import { exchanges, isPersonMessage, namedIn, personWords, shorten, textOf } from './history.ts';
import type {
  BudgetPlan, CallPlan, CallProtocol, ChatMode, ChosenContext, ChosenFn, Contextor, ContextorDeps, ContextorInput, DraftInput, ExposedTo, ModeChoice, ModeContext, ModelCallOut, ModelLimitsService, Overflow,
  ModeTool, PlanInput, PlannedPrompt, PromptPlanner, RenderedIteration, Selection, TokenEstimates, TokenEstimator,
} from './index.ts';
import { AUTO_MODEL } from './limits.ts';
import { fitInjected, fixedHash, gatherInjected, injectedFns, injectedShown, injectedTemplate, placeInjected, type InjectedGather } from './injected.ts';
import { PLAIN_EXAMPLES, promptExamples, spelled, type ExampleWriter, type ExamplesMode } from './examples.ts';
import { CHAT_MODES, modeNames } from './modes.ts';
import { broughtWords, contextBlock, earlierBlock, moreContext, type BroughtFnLines, type BroughtWords } from './render.ts';
import { MESSAGE_FRAMING } from './tokens.ts';
import { fnRefusal, readsAsMissing, refusalOf, usable } from './views.ts';
import type { AccessScope } from '../access/index.ts';

/** A prompt that cannot be made small enough for its model. Its message says both numbers in plain words. */
export class PromptTooLarge extends Error implements Overflow {
  readonly report: Overflow['report'];

  constructor(overflow: Overflow) {
    super(overflow.message);
    this.name = 'PromptTooLarge';
    this.report = overflow.report;
  }
}

/** The chat mode and contextor a run uses: the session's, else the agent's, else build 1's. Defaults are filled in. */
export function modeChoice(session: Pick<Session, 'mode' | 'contextor'> | undefined, payload: Pick<LlmPayload, 'mode' | 'contextor'>): ModeChoice {
  return {
    mode: ChatModeConfig.parse(session?.mode ?? payload.mode ?? DEFAULT_CHAT_MODE),
    contextor: ContextorConfig.parse(session?.contextor ?? payload.contextor ?? DEFAULT_CONTEXTOR),
  };
}

/** How a prompt in a chat mode, speaking a protocol, shows fns' examples (`promptExamples`). */
export function examplesMode(mode: 'tools' | 'static', protocol: CallProtocol): ExamplesMode {
  return mode === 'tools' ? 'tools' : protocol === 'text' ? 'text' : 'static';
}

/** Build the mode of a config. */
export function chatModeOf(config: ChatModeConfig, deps: ContextorDeps): ChatMode {
  switch (config.type) {
    case 'tools': return CHAT_MODES.tools(config, deps);
    case 'static': return CHAT_MODES.static(config, deps);
  }
}

/** Build the contextor of a config. */
export function contextorOf(config: ContextorConfig, deps: ContextorDeps): Contextor {
  switch (config.type) {
    case 'plain': return CONTEXTORS.plain(config, deps);
    case 'suggest': return CONTEXTORS.suggest(config, deps);
    case 'graph': return CONTEXTORS.graph(config, deps);
  }
}

/** Context in the order a prompt shows it: a parent before its children, a chain in order, else by activation. */
export function contextOrder(chosen: readonly ChosenContext[]): ChosenContext[] {
  const byName = new Map(chosen.map((c) => [c.record.name, c]));
  const out: ChosenContext[] = [];
  const placed = new Set<string>();
  const place = (item: ChosenContext, path: Set<string>): void => {
    if (placed.has(item.record.name) || path.has(item.record.name)) return;
    path.add(item.record.name);
    const before = [item.record.decl.parent, ...chosen.filter((c) => c.record.decl.next === item.record.name).map((c) => c.record.name)];
    for (const name of before) { const first = name === undefined ? undefined : byName.get(name); if (first !== undefined) place(first, path); }
    placed.add(item.record.name);
    out.push(item);
  };
  for (const item of chosen) place(item, new Set());
  return out;
}

/** What blocks each fn the shown context brings, as `fnRefusal` says it (undefined for one that can be used). */
export type BroughtBlocks = ReadonlyMap<string, FnBlock | undefined>;

/**
 * A context item's brought fns as its block tells them: `added` only when this step's tools have them, `blocked` with
 * the hub's reason when they can't be used now, `waiting` for the rest; one that reads as missing (unseen, not for the
 * model) is not named at all.
 */
export function broughtLines(fns: readonly string[], inTools: ReadonlySet<string>, blocks: BroughtBlocks, words?: BroughtWords): BroughtFnLines {
  const added: string[] = [];
  const waiting: string[] = [];
  const blocked: FnRefusal[] = [];
  for (const fn of fns) {
    const block = blocks.get(fn);
    if (inTools.has(fn)) added.push(fn);
    else if (block === undefined) waiting.push(fn);
    else if (!readsAsMissing(block)) blocked.push(refusalOf(fn, block));
  }
  return { added, waiting, blocked, ...(words === undefined ? {} : { words }) };
}

/**
 * The system message's text after the instructions: its fixed part (`fixedRegion`), context, earlier summaries, fn
 * cards. Each context block names the fns it brings for what they are this step (`broughtLines`), from `held`, in the
 * chat mode's `words` (`broughtWords`: in the tools, or cards run by name in the static toolset).
 */
export function contextRegion(fixed: string, selection: Pick<Selection, 'context' | 'earlier' | 'fns'>, systemEnd: string, held: BroughtBlocks = new Map(), words?: BroughtWords): string {
  const ordered = contextOrder(selection.context);
  const inTools = new Set<string>(selection.fns.filter((f) => f.detail !== 'listed').map((f) => f.view.record.name));
  const blocks = ordered.filter((c) => c.detail !== 'listed').map((c) => contextBlock({
    name: c.record.name, title: c.record.decl.title, detail: c.detail, text: c.text, fns: broughtLines(c.record.decl.fns, inTools, held, words), ...(c.choices === undefined ? {} : { choices: c.choices }),
  }));
  const listed = moreContext(ordered.filter((c) => c.detail === 'listed').map((c) => c.record));
  return [fixed, ...blocks, listed, ...selection.earlier.map(earlierBlock), systemEnd].filter((part) => part !== '').join('\n\n');
}

/**
 * What the system message always has after the instructions: the `<systems>` list, then the mode's guide, then the
 * citation rule when the chat had citations on at its first turn (`citations`, from `chat/cite-rule.ts`). The list is
 * the set snapshotted at the chat's first turn (`Session.announcedSystems.prompt`), in name order, never the set as it
 * is now, so the prompt stays the same and caches; what changes later is told in the person's messages.
 */
export function fixedRegion(systems: readonly AnnouncedSystem[], guide: string, citations = '', detail: 'full' | 'summary' = 'full'): string {
  return [systemsPrompt(systems, detail), guide, citations].filter((part) => part !== '').join('\n\n');
}

/** What the planner uses. */
export interface PlannerDeps extends ContextorDeps {
  readonly store: HubStore;
  readonly catalog: ContextorDeps['catalog'] & Pick<Catalog, 'entries' | 'modelNames' | 'availability'>;
  readonly limits: Pick<ModelLimitsService, 'resolve'>;
  readonly tokens: TokenEstimates;
  /** The chat models the hub AI can call now (for whether a model takes native tools). */
  readonly models: () => Promise<readonly ModelInfo[]>;
  /** Which model a choice means (for previews, which have no agent run to ask). */
  readonly resolver: Pick<ModelResolver, 'resolve'>;
  readonly log: Logger;
}

/** One planning, inside the planner. */
interface Planning {
  readonly session: Session | undefined;
  readonly user: ActorId;
  readonly turn: Turn | undefined;
  readonly agent: FnRecord;
  readonly model: string;
  readonly instructions: string;
  readonly transcript: readonly LlmMessage[];
  readonly cached: SelectionReport | undefined;
  /** Whether to keep the selection on the session (not for previews). */
  readonly keep: boolean;
}

/** An agent's injected section for one turn: its text, the context it shows and the fns it brings, and its report. */
interface InjectedPart {
  readonly text: string;
  readonly tokens: number;
  /** Context items the section shows: already in the prompt, for every contextor. */
  readonly shown: readonly QualifiedName[];
  /** The fns its shown items bring: among the agent's starting tools. */
  readonly fns: readonly QualifiedName[];
  readonly cut: ReadonlyArray<{ what: string; why: string }>;
  readonly report: InjectedReport | undefined;
}

/** An agent that takes no injected section (`injected: 'none'`). */
const NO_INJECTED: InjectedPart = { text: '', tokens: 0, shown: [], fns: [], cut: [], report: undefined };

/** The injected section as far as reading goes: done (none, or kept for this turn), or its items to fit. */
type Injecting = { readonly part: InjectedPart } | { readonly gathered: InjectedGather };

/** The planner. */
export class HubPromptPlanner implements PromptPlanner {
  readonly #deps: PlannerDeps;
  /** Each turn's injected section (by session, turn, agent and model), so every step of a turn sends the same fixed region. */
  readonly #sections = new Map<string, InjectedPart>();

  constructor(deps: PlannerDeps) {
    this.#deps = deps;
  }

  plan(input: PlanInput): Promise<PlannedPrompt> {
    return this.#plan({
      session: input.session, user: input.turn.user.id, turn: input.turn, agent: input.agent, model: input.model, instructions: input.instructions,
      transcript: input.transcript, cached: input.cached, keep: true,
    });
  }

  interpret(call: ModelCallOut, prompt: PlannedPrompt): Promise<CallPlan> {
    return prompt.mode.interpret(call, prompt.rendered, { session: prompt.session, access: prompt.access });
  }

  async exposed(exposures: readonly Exposure[], to: ExposedTo): Promise<string> {
    const chosen: ChosenFn[] = [];
    for (const exposure of exposures) {
      const view = await this.#deps.views.view(exposure.fn);
      if (view !== undefined && usable(view.record, to.session, to.access)) chosen.push({ view, detail: exposure.detail, activation: 1 });
    }
    if (chosen.length === 0) return '';
    const { mode, ctx } = await this.#mode(to.session, to.agent, to.model);
    return mode.exposed(chosen, ctx);
  }

  /** The mode a session's agent uses with a model, and what it renders with. */
  async #mode(session: Session | undefined, agent: FnRecord, model: string): Promise<{ mode: ChatMode; ctx: ModeContext; payload: LlmPayload; choice: ModeChoice; info: ModelInfo | undefined }> {
    const payload = parseValue(LlmPayloadType, agent.decl.payload);
    const choice = modeChoice(session, payload);
    const mode = chatModeOf(choice.mode, this.#deps);
    const info = (await this.#deps.models()).find((m) => namesModel(model, m));
    const nativeTools = info?.capabilities.includes('tools') ?? true;
    // the one fn name: every fn this prompt names is spelled as the model calls it in this mode
    const names = modeNames(mode.type, await this.#deps.catalog.modelNames());
    const protocol = mode.protocol(nativeTools);
    // examples that aren't a tool's own: as the model would send them here (static `run`, or the fn's tool once loaded)
    const writer = promptExamples(examplesMode(mode.type, protocol), names, info);
    // an agent that takes its injected section at summary (a small window) takes the systems list and static tools brief too
    const brief = payload.injected !== undefined && payload.injected !== 'none' && payload.injected.detail === 'summary';
    return { mode, ctx: { estimator: await this.#deps.tokens.forModel(model), protocol, names, writer, ...(brief ? { brief } : {}) }, payload, choice, info };
  }

  async writeArgs(to: ExposedTo, calls: ReadonlyArray<{ readonly fn: QualifiedName; readonly args: Json }>): Promise<string[]> {
    const { ctx } = await this.#mode(to.session, to.agent, to.model);
    const writer = ctx.writer ?? PLAIN_EXAMPLES;
    const views = await mapConcurrent(calls, (call) => this.#deps.views.view(call.fn));
    return calls.map((call, index) => { const view = views[index]; return view === undefined ? JSON.stringify(call.args) : writer.args(view, call.args); });
  }

  async writerForRun(run: { readonly parent?: RunId | undefined; readonly user: { readonly id: ActorId } }): Promise<ExampleWriter | undefined> {
    if (run.parent === undefined) return undefined;
    const parent = await this.#deps.store.table('runs').get(run.parent);
    const agent = parent === undefined ? undefined : await this.#deps.catalog.fn(parent.fn);
    if (parent === undefined || agent === undefined) return undefined;
    let payload: LlmPayload;
    try {
      payload = parseValue(LlmPayloadType, agent.decl.payload);
    } catch {
      // not an agent: a hub fn called from code
      return undefined;
    }
    const session = parent.session === undefined ? undefined : await this.#deps.store.table('sessions').get(parent.session);
    const metadata = await this.#deps.resolver.resolve(session?.model ?? ModelChoice.optional().parse(payload.model));
    return this.writer({ session, agent, model: metadata.model ?? AUTO_MODEL, access: await this.#deps.access(run.user.id) }, false);
  }

  async writer(to: ExposedTo, protect = true): Promise<ExampleWriter> {
    const { mode, ctx, info } = await this.#mode(to.session, to.agent, to.model);
    return protect ? ctx.writer ?? PLAIN_EXAMPLES : promptExamples(examplesMode(mode.type, ctx.protocol), ctx.names ?? modeNames(mode.type), info, false);
  }

  async names(to: ExposedTo): Promise<ModelFnNames> {
    const { ctx } = await this.#mode(to.session, to.agent, to.model);
    return ctx.names ?? modeNames('tools');
  }

  async settled(input: { model: string; estimate: number; actual: number | undefined; used: readonly QualifiedName[] }): Promise<void> {
    if (input.actual !== undefined && input.actual > 0 && input.model !== AUTO_MODEL) await this.#deps.tokens.observe(input.model, input.estimate, input.actual);
    if (new Set(input.used).size >= 2) await this.#deps.graph.learn(input.used);
  }

  async preview(sessionId: SessionId, text: string, by: ActorId): Promise<SelectionReport> {
    const session = await this.#deps.store.table('sessions').get(sessionId);
    if (session === undefined) throw new Error(`no session ${sessionId}`);
    const agent = await this.#deps.catalog.fn(session.agent);
    if (agent === undefined) throw new Error(`${session.agent} no longer exists`);
    const payload = parseValue(LlmPayloadType, agent.decl.payload);
    const metadata = await this.#deps.resolver.resolve(session.model ?? ModelChoice.optional().parse(payload.model));
    const planned = await this.#plan({
      session, user: by, turn: undefined, agent, model: metadata.model ?? AUTO_MODEL, instructions: payload.instructions,
      transcript: [...session.transcript, { role: 'user', content: text }], cached: undefined, keep: false,
    });
    return planned.report;
  }

  draft(input: DraftInput): Promise<PlannedPrompt> {
    return this.#plan({ ...input, turn: undefined, cached: undefined, keep: false });
  }

  async #plan(planning: Planning): Promise<PlannedPrompt> {
    const { session, agent, model } = planning;
    const all = exchanges(planning.transcript);
    const currentExchange = all.at(-1);
    const history = all.slice(0, -1);
    // what the prompt is built from, each read as soon as what it needs is known
    const { chosen: { mode, ctx, payload, choice }, view, access, systems, tools, asked, injecting } = await flow()
      .step('chosen', () => this.#mode(session, agent, model))
      .step('view', () => this.#deps.limits.resolve(model))
      .step('access', () => this.#deps.access(planning.user))
      .step('asked', () => this.#asked(planning.turn, currentExchange?.messages ?? []))
      .step('systems', ['access'], ({ access: scope }) => this.#systems(session, scope))
      .step('tools', ['chosen'], ({ chosen: { mode: chatMode, ctx: modeCtx } }) => chatMode.fixedTools(modeCtx))
      .step('injecting', ['chosen', 'access'], ({ chosen: { mode: chatMode, payload: agentPayload }, access: scope }) => this.#gather(planning, chatMode, agentPayload, scope))
      .run();
    const { estimator } = ctx;
    const contextor = contextorOf(choice.contextor, this.#deps);
    const guide = fixedRegion(systems, mode.guide(ctx), citationsPrompt(session), ctx.brief === true ? 'summary' : 'full');
    const rest = MESSAGE_FRAMING + (guide === '' ? 0 : estimator.text(`\n\n${guide}`)) + tools.reduce((sum, t) => sum + estimator.tool(t.spec), 0);
    // an agent that declares no `maxOutput` still gets a bound (`HARNESS_AGENT_MAX_OUTPUT`): a stuck model stops there
    const cap = this.#deps.settings.HARNESS_AGENT_MAX_OUTPUT;
    const maxOutput = payload.maxOutput ?? (cap > 0 ? cap : undefined);
    const reserve = budgetPlan(view.limits, 0, this.#deps.settings.HARNESS_PROMPT_MARGIN, maxOutput);
    // the injected section takes room from history and context, never from the current exchange: at most a share of what
    // the model leaves after the rest of the fixed part, worked out from the model alone so it stays the same each turn
    const bare = estimator.text(planning.instructions) + rest;
    const share = Math.floor(this.#deps.settings.HARNESS_INJECTED_SHARE * Math.max(0, reserve.available - bare));
    const injected = await this.#injectedPart(planning, injecting, { mode, ctx, payload, guide, room: share });
    const instructions = placeInjected(planning.instructions, injected.text);
    const head = estimator.text(instructions) + rest;
    const fitted = this.#fitCurrent(currentExchange?.messages ?? [], reserve, head, estimator, model);
    const plan = budgetPlan(view.limits, head + estimator.messages(fitted.messages), this.#deps.settings.HARNESS_PROMPT_MARGIN, maxOutput);
    const query = currentExchange?.user ?? '';
    // the fns the mode's own tools replace are never shown
    const shown = (names: readonly string[]): string[] => names.filter((name) => !mode.replaces.has(name));
    const inSection = new Set<string>(injected.shown);
    const notInjected = (names: readonly string[]): string[] => names.filter((name) => !inSection.has(name));

    const input = {
      session, user: planning.user, access, turn: planning.turn?.id, agent, payload, query, history, current: fitted.messages,
      // injected items are in the prompt already, so no contextor shows them again; the fns they bring are starting tools
      always: { context: notInjected(payload.context), fns: shown([...payload.tools, ...injected.fns]) },
      loaded: { context: notInjected(session?.context ?? []), fns: shown(session?.tools ?? []) },
      ...asked, asked: { context: notInjected(asked.asked.context), fns: shown(asked.asked.fns) }, person: planning.turn?.user, injected: injected.shown,
      mode, ctx, plan, cached: planning.cached,
    };
    let selection = await this.#forTurn(await contextor.select(input), session, query);
    let rendered = await spoken(await mode.render(selection, ctx));
    let assembled = await this.#assemble(instructions, guide, selection, mode, rendered, estimator, await this.#held(selection, session, access));
    // the parts' estimates can add up to less than the whole's: choose again with less room for the optional parts
    // (the overshoot taken off, at least doubling each time) until it fits; refused only once no optional room is left
    const room = Math.max(0, plan.flexible);
    let taken = 0;
    for (let tries = 0; assembled.estimate > plan.available; tries++) {
      if (tries >= this.#deps.settings.HARNESS_MAX_RESELECTS || taken >= room) throw this.#tooLarge(model, assembled.estimate, plan, selection);
      taken = Math.min(room, Math.max(taken * 2, taken + assembled.estimate - plan.available));
      const tighter: BudgetPlan = { ...plan, flexible: plan.flexible - taken };
      selection = await this.#forTurn(await contextor.select({ ...input, plan: tighter }), session, query);
      rendered = await spoken(await mode.render(selection, ctx));
      assembled = await this.#assemble(instructions, guide, selection, mode, rendered, estimator, await this.#held(selection, session, access));
    }
    const report: SelectionReport = {
      ...selection.report, mode: choice.mode.type, contextor: choice.contextor.type,
      budget: { ...selection.report.budget, estimate: assembled.estimate, cut: [...injected.cut, ...fitted.cut, ...selection.report.budget.cut] },
      ...(injected.report === undefined ? {} : { injected: injected.report }),
    };
    if (report.budget.cut.length > 0) this.#deps.log.info('contextor.cut', { model, cut: report.budget.cut.map((c) => `${c.what}: ${c.why}`) });
    this.#deps.log.debug('contextor.planned', { model, mode: choice.mode.type, contextor: choice.contextor.type, estimate: assembled.estimate, available: plan.available, window: view.limits.contextWindow });
    if (planning.keep && session !== undefined && planning.turn !== undefined && choice.contextor.type === 'graph') await this.#keep(session.id, planning.turn.id, report);
    return {
      model, instructions: rendered.names.text(injectedTemplate(planning.instructions)), injectedContext: injected.text, context: assembled.context, messages: assembled.messages, tools: rendered.tools, maxTokens: plan.output + plan.reasoning, contextWindow: view.limits.contextWindow,
      estimate: assembled.estimate, rendered, report, mode, ctx, session, access: input.access, ...(selection.considered === undefined ? {} : { considered: selection.considered }),
    };
  }

  /**
   * A selection as this turn shows it: only the fns the chat's fn mode allows (none at all in `none`; in `auto` all,
   * since each call is asked about), each card with the examples most relevant to the turn.
   */
  async #forTurn(selection: Selection, session: Session | undefined, query: string): Promise<Selection> {
    const fns = this.#deps.fns;
    if (fns === undefined) return selection;
    const mode = session?.fnMode;
    let chosen = mode === 'none' ? [] : selection.fns;
    if (mode === 'read' || mode === 'write' || mode === 'delete') {
      const modes = await fns.modes(chosen.map((fn) => fn.view.record.name));
      chosen = chosen.filter((fn) => MODE_RANK[modes.get(fn.view.record.name) ?? 'write'] <= MODE_RANK[mode]);
    }
    const withExamples = await Promise.all(chosen.map(async (fn): Promise<ChosenFn> => (fn.detail === 'listed' ? fn : { ...fn, examples: await fns.examples(fn.view.record, query) })));
    return { ...selection, fns: withExamples };
  }

  /**
   * The systems a session's system prompt lists: its first turn's snapshot; before there is one (a preview), the set
   * available now. An agent outside a chat gets none.
   */
  async #systems(session: Session | undefined, access: AccessScope): Promise<readonly AnnouncedSystem[]> {
    if (session === undefined) return [];
    return session.announcedSystems?.prompt ?? (await systemsNow(this.#deps.store, access, session)).on;
  }

  /** What blocks each fn the selection's shown context brings (`fnRefusal`), for its blocks to say only what is true. */
  async #held(selection: Selection, session: Session | undefined, access: AccessScope): Promise<BroughtBlocks> {
    const names = new Set(selection.context.filter((c) => c.detail !== 'listed').flatMap((c) => c.record.decl.fns));
    const records = await mapConcurrent(names, (name) => this.#deps.catalog.fn(name));
    return new Map<string, FnBlock | undefined>([...names].map((name, index) => [name, fnRefusal(records[index], session, access)]));
  }

  /**
   * The system region, the messages and the request's estimate. Out to the model, every fn the instructions, the region
   * and the messages name (the hub's blocks on a person's message, results, background results, refusals) is spelled as
   * the model calls it here, after one lookup of every name they hold (the tail and tools already are, `spoken`).
   */
  async #assemble(instructions: string, guide: string, selection: Selection, mode: ChatMode, rendered: Awaited<ReturnType<ChatMode['render']>>, estimator: TokenEstimator, held: BroughtBlocks) {
    const { names } = rendered;
    const region = contextRegion(guide, selection, rendered.systemEnd, held, broughtWords(mode.type, rendered.protocol));
    await names.learn([instructions, region, ...selection.linear.flatMap(messageTexts)]);
    // its fns spelled, then its examples (kept from the speller) written as they are
    const context = spelled(names, region);
    const messages: LlmMessage[] = [...selection.linear.map((message) => spokenMessage(message, names)), ...(rendered.tail === undefined ? [] : [{ role: 'system' as const, content: plainDeferred(rendered.tail) }])];
    const system = context === '' ? instructions : `${instructions}\n\n${context}`;
    const estimate = estimator.message({ role: 'system', content: system }) + rendered.tools.reduce((sum, t) => sum + estimator.tool(t.spec), 0) + estimator.messages(messages);
    return { context, messages, estimate };
  }

  /**
   * The current exchange within `room` tokens: whole, else without the hub's blocks on the person's message, else with
   * older tool results shortened, else with the newest shortened too; refused when even the person's words won't fit.
   * `room` is what the budget leaves after the instructions, the mode's guide and its tools (`head`).
   */
  #fitCurrent(messages: readonly LlmMessage[], reserve: BudgetPlan, head: number, estimator: TokenEstimator, model: string): { messages: LlmMessage[]; cut: Array<{ what: string; why: string }> } {
    const room = reserve.available - head;
    const cut: Array<{ what: string; why: string }> = [];
    let current = [...messages];
    const fits = (): boolean => estimator.messages(current) <= room;
    if (fits()) return { messages: current, cut };
    current = current.map((m) => (isPersonMessage(m) && typeof m.content === 'string' ? { ...m, content: personWords(m.content) } : m));
    cut.push({ what: 'the hub\'s notes on the message', why: 'left out to fit the model\'s window' });
    if (fits()) return { messages: current, cut };
    const results = current.flatMap((m, i) => (m.role === 'tool' || (m.role === 'user' && !isPersonMessage(m)) ? [i] : []));
    const newest = results.at(-1);
    for (const i of results.slice(0, -1)) current[i] = shortenMessage(current[i], this.#deps.settings.HARNESS_OLD_RESULT_CHARS);
    if (results.length > 1) cut.push({ what: `${results.length - 1} earlier tool results of this turn`, why: 'shortened to fit' });
    if (fits()) return { messages: current, cut };
    if (newest !== undefined) {
      let chars = textOf(current[newest] ?? { role: 'tool', content: '' }).length;
      while (!fits() && chars > this.#deps.settings.HARNESS_MIN_RESULT_CHARS) {
        chars = Math.max(this.#deps.settings.HARNESS_MIN_RESULT_CHARS, Math.floor(chars / 2));
        current[newest] = shortenMessage(messages[newest], chars);
      }
      cut.push({ what: 'the newest tool result', why: 'shortened to fit' });
      if (fits()) return { messages: current, cut };
    }
    const words = estimator.messages(current);
    const fit = Math.max(0, room);
    throw new PromptTooLarge({
      message: `This message is about ${words.toLocaleString('en-US')} tokens; ${model} takes ${fit.toLocaleString('en-US')} here. Shorten it or pick a model with a larger window.`,
      report: { window: reserve.limits.contextWindow, output: reserve.output, reasoning: reserve.reasoning, margin: reserve.margin, fixed: head + words, pools: emptyPools(), estimate: head + words, cut },
    });
  }

  #tooLarge(model: string, estimate: number, plan: BudgetPlan, selection: Selection): PromptTooLarge {
    return new PromptTooLarge({
      message: `This prompt is about ${estimate.toLocaleString('en-US')} tokens; ${model} takes ${plan.available.toLocaleString('en-US')} here. Shorten the message or pick a model with a larger window.`,
      report: { ...selection.report.budget, estimate },
    });
  }

  /**
   * What the agent's injected section is made of (`gatherInjected`: a dynamic item is written by its system), or the
   * section itself when there is none or this turn's is kept already. Read alongside the rest of the prompt's parts.
   */
  async #gather(planning: Planning, mode: ChatMode, payload: LlmPayload, access: AccessScope): Promise<Injecting> {
    if (payload.injected === 'none') return { part: NO_INJECTED };
    const key = this.#sectionKey(planning);
    const kept = key === undefined ? undefined : this.#sections.get(key);
    if (kept !== undefined) return { part: kept };
    const { session, turn, agent } = planning;
    const gathered = await gatherInjected(
      { store: this.#deps.store, catalog: this.#deps.catalog, dynamic: this.#deps.dynamic, fns: this.#deps.fns, parallel: this.#deps.settings.HARNESS_CONTEXT_PARALLEL },
      { agent, session, access, user: planning.user, person: turn?.user, mode: mode.type },
    );
    return { gathered };
  }

  /** The key a turn's injected section is kept under for its steps; undefined when it is not kept (a preview, a run outside a chat). */
  #sectionKey(planning: Planning): string | undefined {
    const { session, turn, agent, model } = planning;
    return planning.keep && session !== undefined && turn !== undefined ? compositeKey(session.id, turn.id, agent.name, model) : undefined;
  }

  /**
   * The agent's injected section for this turn (`injected.ts`): what reaches it, fitted to its detail and within its
   * cap and `room`, with fn names as the model calls them here. Worked out once per turn and kept for its steps. At a
   * turn's first step the fixed region's hash is compared with the session's stamp, and the stamp rewritten only when
   * the region changed: then the report says so (`rebuilt`, with the items added and dropped) and the change is
   * logged. A turn already stamped (the hub restarted mid-turn) keeps the items it was built with; changes wait for
   * the next turn. The stamp is the session's own agent's; another agent run in the chat keeps its section for the
   * turn in memory only. Previews and runs outside a chat work it out fresh and keep nothing.
   */
  async #injectedPart(planning: Planning, injecting: Injecting, at: { mode: ChatMode; ctx: ModeContext; payload: LlmPayload; guide: string; room: number }): Promise<InjectedPart> {
    if ('part' in injecting) return injecting.part;
    const { gathered } = injecting;
    const taken = at.payload.injected === undefined || at.payload.injected === 'none' ? { detail: 'full' as const } : at.payload.injected;
    const { session, turn, agent } = planning;
    const key = this.#sectionKey(planning);
    // the stamp is the session's own agent's: another agent run in the chat (a sub-agent) works its section out alone
    const own = key !== undefined && session?.agent === agent.name;
    const stamp = own ? session.fixed : undefined;
    const sameTurn = stamp !== undefined && turn !== undefined && stamp.at === turn.id;
    const items = sameTurn ? gathered.items.filter((item) => stamp.injected.includes(item.name)) : gathered.items;
    const names = at.ctx.names ?? modeNames(at.mode.type);
    // the names the items' texts hold are looked up in one batch before they are spelled
    await names.learn(items.flatMap((item) => [item.title, item.full, item.summary]));
    const fitted = fitInjected(items, {
      detail: taken.detail ?? 'full', room: Math.min(taken.maxTokens ?? Number.POSITIVE_INFINITY, at.room), estimator: at.ctx.estimator, render: (text) => names.text(text),
    });
    const placed = fitted.placed.map((p) => p.item.name);
    let rebuilt: InjectedReport['rebuilt'];
    if (own && turn !== undefined) {
      const hash = fixedHash(`${placeInjected(planning.instructions, fitted.text)}\n\n${at.guide}`);
      if (stamp?.hash !== hash) {
        await this.#deps.store.table('sessions').update(session.id, { fixed: { hash, injected: placed, at: turn.id } });
        if (stamp !== undefined) {
          rebuilt = { added: placed.filter((name) => !stamp.injected.includes(name)), dropped: stamp.injected.filter((name) => !placed.includes(name)) };
          this.#deps.log.info('contextor.fixed-rebuilt', { session: session.id, turn: turn.id, agent: agent.name, ...rebuilt });
        }
      }
    }
    const part: InjectedPart = {
      text: fitted.text, tokens: fitted.tokens, shown: injectedShown(fitted.placed), fns: injectedFns(fitted.placed), cut: fitted.cut,
      report: {
        tokens: fitted.tokens,
        items: fitted.placed.map((p) => ({ name: p.item.name, detail: p.detail, tokens: p.tokens })),
        leftOut: [...gathered.leftOut, ...fitted.noFit].map((left) => ({ name: left.name, why: left.why, reason: left.reason })),
        ...(rebuilt === undefined ? {} : { rebuilt }),
      },
    };
    if (key !== undefined) {
      this.#sections.set(key, part);
      for (const old of this.#sections.keys()) {
        if (this.#sections.size <= this.#deps.settings.HARNESS_INJECTED_STEPS) break;
        this.#sections.delete(old);
      }
    }
    return part;
  }

  /** What the current message asks for: its `/command` context (with each command's args), and the fns its person names (`fs/bash`, `@` mentions). */
  async #asked(turn: Turn | undefined, current: readonly LlmMessage[]): Promise<Pick<ContextorInput, 'asked' | 'commands'>> {
    const row = turn?.message === undefined ? undefined : await this.#deps.store.table('messages').get(turn.message);
    const commands = (row?.parts ?? []).flatMap((part) => (part.type === 'command' ? [part] : []));
    const context = commands.map((part) => part.context);
    const person = current.find(isPersonMessage);
    const named = person === undefined ? [] : namedIn(personWords(textOf(person)));
    const parsed = named.flatMap((name) => { const one = QualifiedName.safeParse(name); return one.success ? [one.data] : []; });
    const records = await mapConcurrent(parsed, (name) => this.#deps.catalog.fn(name));
    const fns = parsed.filter((_name, index) => records[index] !== undefined);
    return { asked: { context, fns }, commands: new Map(commands.map((part) => [part.context, part.args])) };
  }

  /** Keep a graph selection on the session, for the next cycle's `selectedBefore`. */
  async #keep(session: SessionId, turn: TurnId, report: SelectionReport): Promise<void> {
    await this.#deps.store.table('sessions').update(session, { selection: { turn, items: [...report.context, ...report.fns], at: this.#deps.clock() } });
  }
}

/**
 * A rendered iteration as the model reads it: its tools' descriptions and its trailing card message with every fn they
 * name spelled as the model calls it here (`ModelFnNames.text`). The system region is spelled when it is assembled.
 */
export async function spoken(rendered: RenderedIteration): Promise<RenderedIteration> {
  const { names } = rendered;
  // every name the tools and the tail hold, looked up in one batch first
  await names.learn([
    rendered.tail, ...rendered.tools.flatMap((tool) => [tool.description, tool.instructions, tool.spec.description, ...schemaDescriptions(tool.spec.parameters)]),
  ]);
  const tools = rendered.tools.map((tool): ModeTool => ({
    ...tool,
    description: names.text(tool.description),
    ...(tool.instructions === undefined ? {} : { instructions: names.text(tool.instructions) }),
    spec: {
      ...tool.spec,
      ...(tool.spec.description === undefined ? {} : { description: names.text(tool.spec.description) }),
      parameters: spokenSchema(tool.spec.parameters, names),
    },
  }));
  return { ...rendered, tools, ...(rendered.tail === undefined ? {} : { tail: names.text(rendered.tail) }) };
}

/** The `description` texts of a JSON schema, at any depth (a field's own words, which may name fns). */
function schemaDescriptions(schema: Json): string[] {
  if (Array.isArray(schema)) return schema.flatMap(schemaDescriptions);
  if (schema === null || typeof schema !== 'object') return [];
  return Object.entries(schema).flatMap(([key, value]) => (key === 'description' && typeof value === 'string' ? [value] : schemaDescriptions(value)));
}

/** A JSON schema with its `description` texts spelled for the model; patterns, enums and defaults are left as they are. */
function spokenSchema(schema: Json, names: ModelFnNames): Json {
  if (Array.isArray(schema)) return schema.map((item) => spokenSchema(item, names));
  if (schema === null || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === 'description' && typeof value === 'string' ? names.text(value) : spokenSchema(value, names)]));
}

/** The texts of a message the hub spells (a person's, a tool's or a system message; the model's own words stay its own). */
function messageTexts(message: LlmMessage): string[] {
  if (message.role === 'assistant') return [];
  return typeof message.content === 'string' ? [message.content] : message.content.flatMap((part) => (part.type === 'text' ? [part.content] : []));
}

/** A message with every fn its text names spelled as the model calls it here (after `learn` over `messageTexts`). */
function spokenMessage(message: LlmMessage, names: ModelFnNames): LlmMessage {
  if (message.role === 'assistant') return message;
  if (typeof message.content === 'string') return { ...message, content: spelled(names, message.content) };
  return { ...message, content: message.content.map((part) => (part.type === 'text' ? { ...part, content: spelled(names, part.content) } : part)) };
}

/** A message with its text shortened to `max` characters (string content only). */
function shortenMessage(message: LlmMessage | undefined, max: number): LlmMessage {
  if (message === undefined) return { role: 'tool', content: '' };
  return typeof message.content === 'string' ? { ...message, content: shorten(message.content, max) } : message;
}

function emptyPools() {
  return { history: { asked: 0, got: 0 }, context: { asked: 0, got: 0 }, fns: { asked: 0, got: 0 } };
}
