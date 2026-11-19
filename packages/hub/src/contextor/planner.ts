/**
 * The planner the agent loop calls before every LLM call. It picks the session's chat mode and contextor (the
 * session's override, else the agent payload's, else build 1's), measures the fixed part (the instructions with the
 * mode's guide, the mode's tools, the current exchange), trims the current exchange when even that doesn't fit (the
 * hub's blocks on the person's message first, then older tool results, then the newest one) or refuses with a plain
 * message, asks the contextor for a selection within what is left, renders it with the mode, and checks the request's
 * estimate against the budget. `maxTokens` and `contextWindow` go on every request. A session's system message lists,
 * after the instructions, the systems its first turn found available (`fixedRegion`), the same every step so it caches.
 */
import type { Logger } from '@ayepi/log';
import {
  ChatModeConfig, ContextorConfig, DEFAULT_CHAT_MODE, DEFAULT_CONTEXTOR, ModelChoice, namesModel, QualifiedName, type ActorId, type AnnouncedSystem, type ContextViewer, type Exposure, type FnBlock, type FnRecord, type FnRefusal, type LlmMessage, type ModelInfo,
  type Session, type SessionId, type SelectionReport, type Turn, type TurnId,
} from '@harness/core';
import { LlmPayloadType, parseValue, type LlmPayload } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import type { ModelResolver } from '../execution/models.ts';
import { visibleMade } from '../resources/context.ts';
import { systemsNow, systemsPrompt } from '../chat/announce.ts';
import { MODE_RANK } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import { budgetPlan } from './budget.ts';
import { CONTEXTORS } from './contextors.ts';
import { exchanges, isPersonMessage, namedIn, personWords, shorten, textOf } from './history.ts';
import type {
  BudgetPlan, CallPlan, ChatMode, ChosenContext, ChosenFn, Contextor, ContextorDeps, ContextorInput, ExposedTo, ModeChoice, ModeContext, ModelCallOut, ModelLimitsService, Overflow,
  PlanInput, PlannedPrompt, PromptPlanner, Selection, TokenEstimates, TokenEstimator,
} from './index.ts';
import { AUTO_MODEL } from './limits.ts';
import { CHAT_MODES } from './modes.ts';
import { contextBlock, earlierBlock, moreContext, type BroughtFnLines } from './render.ts';
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
export function broughtLines(fns: readonly string[], inTools: ReadonlySet<string>, blocks: BroughtBlocks): BroughtFnLines {
  const added: string[] = [];
  const waiting: string[] = [];
  const blocked: FnRefusal[] = [];
  for (const fn of fns) {
    const block = blocks.get(fn);
    if (inTools.has(fn)) added.push(fn);
    else if (block === undefined) waiting.push(fn);
    else if (!readsAsMissing(block)) blocked.push(refusalOf(fn, block));
  }
  return { added, waiting, blocked };
}

/**
 * The system message's text after the instructions: its fixed part (`fixedRegion`), context, earlier summaries, fn
 * cards. Each context block names the fns it brings for what they are this step (`broughtLines`), from `held`.
 */
export function contextRegion(fixed: string, selection: Pick<Selection, 'context' | 'earlier' | 'fns'>, systemEnd: string, held: BroughtBlocks = new Map()): string {
  const ordered = contextOrder(selection.context);
  const inTools = new Set<string>(selection.fns.filter((f) => f.detail !== 'listed').map((f) => f.view.record.name));
  const blocks = ordered.filter((c) => c.detail !== 'listed').map((c) => contextBlock({
    name: c.record.name, title: c.record.decl.title, detail: c.detail, text: c.text, fns: broughtLines(c.record.decl.fns, inTools, held), ...(c.choices === undefined ? {} : { choices: c.choices }),
  }));
  const listed = moreContext(ordered.filter((c) => c.detail === 'listed').map((c) => c.record));
  return [fixed, ...blocks, listed, ...selection.earlier.map(earlierBlock), systemEnd].filter((part) => part !== '').join('\n\n');
}

/**
 * What the system message always has after the instructions: the `<systems>` list, then the mode's guide. The list is
 * the set snapshotted at the chat's first turn (`Session.announcedSystems.prompt`), in name order, never the set as it
 * is now, so the prompt stays the same and caches; what changes later is told in the person's messages.
 */
export function fixedRegion(systems: readonly AnnouncedSystem[], guide: string): string {
  return [systemsPrompt(systems), guide].filter((part) => part !== '').join('\n\n');
}

/** What the planner uses. */
export interface PlannerDeps extends ContextorDeps {
  readonly store: HubStore;
  readonly catalog: ContextorDeps['catalog'] & Pick<Catalog, 'entries'>;
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

/** The planner. */
export class HubPromptPlanner implements PromptPlanner {
  readonly #deps: PlannerDeps;

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
  async #mode(session: Session | undefined, agent: FnRecord, model: string): Promise<{ mode: ChatMode; ctx: ModeContext; payload: LlmPayload; choice: ModeChoice }> {
    const payload = parseValue(LlmPayloadType, agent.decl.payload);
    const choice = modeChoice(session, payload);
    const mode = chatModeOf(choice.mode, this.#deps);
    const nativeTools = (await this.#deps.models()).find((m) => namesModel(model, m))?.capabilities.includes('tools') ?? true;
    return { mode, ctx: { estimator: await this.#deps.tokens.forModel(model), protocol: mode.protocol(nativeTools) }, payload, choice };
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

  async #plan(planning: Planning): Promise<PlannedPrompt> {
    const { session, agent, model } = planning;
    const { mode, ctx, payload, choice } = await this.#mode(session, agent, model);
    const { estimator } = ctx;
    const view = await this.#deps.limits.resolve(model);
    const contextor = contextorOf(choice.contextor, this.#deps);
    const all = exchanges(planning.transcript);
    const currentExchange = all.at(-1);
    const history = all.slice(0, -1);
    const access = await this.#deps.access(planning.user);
    const guide = fixedRegion(await this.#systems(session, access), mode.guide(ctx));
    const tools = await mode.fixedTools(ctx);
    const head = estimator.text(planning.instructions) + MESSAGE_FRAMING + (guide === '' ? 0 : estimator.text(`\n\n${guide}`)) + tools.reduce((sum, t) => sum + estimator.tool(t.spec), 0);
    const reserve = budgetPlan(view.limits, 0, this.#deps.settings.HARNESS_PROMPT_MARGIN, payload.maxOutput);
    const fitted = this.#fitCurrent(currentExchange?.messages ?? [], reserve, head, estimator, model);
    const plan = budgetPlan(view.limits, head + estimator.messages(fitted.messages), this.#deps.settings.HARNESS_PROMPT_MARGIN, payload.maxOutput);
    const query = currentExchange?.user ?? '';
    // the fns the mode's own tools replace are never shown
    const shown = (names: readonly string[]): string[] => names.filter((name) => !mode.replaces.has(name));
    const asked = await this.#asked(planning.turn, currentExchange?.messages ?? []);

    const input = {
      session, user: planning.user, access, turn: planning.turn?.id, agent, payload, query, history, current: fitted.messages,
      always: { context: [...payload.context, ...(await this.#alwaysFor(agent.name, { actor: planning.user, session: session?.id }))], fns: shown(payload.tools) },
      loaded: { context: session?.context ?? [], fns: shown(session?.tools ?? []) },
      ...asked, asked: { ...asked.asked, fns: shown(asked.asked.fns) }, person: planning.turn?.user,
      mode, ctx, plan, cached: planning.cached,
    };
    let selection = await this.#forTurn(await contextor.select(input), session, query);
    let rendered = await mode.render(selection, ctx);
    let assembled = this.#assemble(planning.instructions, guide, selection, rendered, estimator, await this.#held(selection, session, access));
    // the parts' estimates can add up to less than the whole's: choose again with less room for the optional parts
    // (the overshoot taken off, at least doubling each time) until it fits; refused only once no optional room is left
    const room = Math.max(0, plan.flexible);
    let taken = 0;
    for (let tries = 0; assembled.estimate > plan.available; tries++) {
      if (tries >= this.#deps.settings.HARNESS_MAX_RESELECTS || taken >= room) throw this.#tooLarge(model, assembled.estimate, plan, selection);
      taken = Math.min(room, Math.max(taken * 2, taken + assembled.estimate - plan.available));
      const tighter: BudgetPlan = { ...plan, flexible: plan.flexible - taken };
      selection = await this.#forTurn(await contextor.select({ ...input, plan: tighter }), session, query);
      rendered = await mode.render(selection, ctx);
      assembled = this.#assemble(planning.instructions, guide, selection, rendered, estimator, await this.#held(selection, session, access));
    }
    const report: SelectionReport = {
      ...selection.report, mode: choice.mode.type, contextor: choice.contextor.type,
      budget: { ...selection.report.budget, estimate: assembled.estimate, cut: [...fitted.cut, ...selection.report.budget.cut] },
    };
    if (report.budget.cut.length > 0) this.#deps.log.info('contextor.cut', { model, cut: report.budget.cut.map((c) => `${c.what}: ${c.why}`) });
    this.#deps.log.debug('contextor.planned', { model, mode: choice.mode.type, contextor: choice.contextor.type, estimate: assembled.estimate, available: plan.available, window: view.limits.contextWindow });
    if (planning.keep && session !== undefined && planning.turn !== undefined && choice.contextor.type === 'graph') await this.#keep(session.id, planning.turn.id, report);
    return {
      model, context: assembled.context, messages: assembled.messages, tools: rendered.tools, maxTokens: plan.output + plan.reasoning, contextWindow: view.limits.contextWindow,
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
    const held = new Map<string, FnBlock | undefined>();
    for (const name of names) held.set(name, fnRefusal(await this.#deps.catalog.fn(name), session, access));
    return held;
  }

  /** The system region, the messages and the request's estimate. */
  #assemble(instructions: string, guide: string, selection: Selection, rendered: Awaited<ReturnType<ChatMode['render']>>, estimator: TokenEstimator, held: BroughtBlocks) {
    const context = contextRegion(guide, selection, rendered.systemEnd, held);
    const messages: LlmMessage[] = [...selection.linear, ...(rendered.tail === undefined ? [] : [{ role: 'system' as const, content: rendered.tail }])];
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

  /** Context that names this agent in `alwaysFor`: systems' context, and the hub-made context (memory, from resources) the viewer may see. */
  async #alwaysFor(agent: QualifiedName, viewer: ContextViewer): Promise<QualifiedName[]> {
    const [declared, made] = await Promise.all([this.#deps.catalog.entries('context'), visibleMade(this.#deps.store, viewer)]);
    return [...new Set([...declared, ...made].filter((item) => item.decl.alwaysFor.includes(agent)).map((item) => item.name))];
  }

  /** What the current message asks for: its `/command` context (with each command's args), and the fns its person names (`fs/bash`, `@` mentions). */
  async #asked(turn: Turn | undefined, current: readonly LlmMessage[]): Promise<Pick<ContextorInput, 'asked' | 'commands'>> {
    const row = turn?.message === undefined ? undefined : await this.#deps.store.table('messages').get(turn.message);
    const commands = (row?.parts ?? []).flatMap((part) => (part.type === 'command' ? [part] : []));
    const context = commands.map((part) => part.context);
    const person = current.find(isPersonMessage);
    const named = person === undefined ? [] : namedIn(personWords(textOf(person)));
    const fns: QualifiedName[] = [];
    for (const name of named) {
      const parsed = QualifiedName.safeParse(name);
      if (parsed.success && (await this.#deps.catalog.fn(parsed.data)) !== undefined) fns.push(parsed.data);
    }
    return { asked: { context, fns }, commands: new Map(commands.map((part) => [part.context, part.args])) };
  }

  /** Keep a graph selection on the session, for the next cycle's `selectedBefore`. */
  async #keep(session: SessionId, turn: TurnId, report: SelectionReport): Promise<void> {
    await this.#deps.store.table('sessions').update(session, { selection: { turn, items: [...report.context, ...report.fns], at: this.#deps.clock() } });
  }
}

/** A message with its text shortened to `max` characters (string content only). */
function shortenMessage(message: LlmMessage | undefined, max: number): LlmMessage {
  if (message === undefined) return { role: 'tool', content: '' };
  return typeof message.content === 'string' ? { ...message, content: shorten(message.content, max) } : message;
}

function emptyPools() {
  return { history: { asked: 0, got: 0 }, context: { asked: 0, got: 0 }, fns: { asked: 0, got: 0 } };
}
