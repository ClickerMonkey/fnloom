/**
 * The admin's view of injected context (plan `injected-context-2026-11-22`, slice F): for any agent (`hub/llm` fn),
 * what is injected into its system prompt, in order, as the model reads it, with each item's state and why it is left
 * out; and the admin's per-agent switch and order (`injectionSettings`). `hub/ctx_injections_list` and
 * `hub/ctx_injection_set` and their web endpoints run these.
 *
 * There is no second implementation: what reaches an agent, in which order and why an item is left out is the
 * planner's `gatherInjected`, and the detail each item gets, its tokens and what doesn't fit is its `fitInjected`
 * (`contextor/injected.ts`), with fn names spelled by the same `modeNames` the planner uses. They run for a **new chat
 * with this agent**, as the admin asking: every system on (`systems: 'all'`), the fn setting the query names (default:
 * none set, as far as policies allow), the chat mode the query names (default: the agent's own, else the hub's), so a
 * hook's `explains` shows as it would for the chat's agent. Two things a real turn adds are not known here: the
 * model's window (room is the agent's own cap, `injected.maxTokens`) and the model's calibration when the agent names
 * no fixed model (tokens are then at the default characters per token).
 */
import { reject } from '@ayepi/core';
import {
  AgentInjected, InjectionSetting, InjectionView, InjectTargetView, mintId, ModelChoice, type ActorId, type ChatFnMode, type ChatModeType, type FnRecord, type InjectionLeftOut,
  type InjectionsPage, type InjectionsQuery, type QualifiedName, type SetInjection,
} from '@harness/core';
import { LlmPayloadType, parseValue, type LlmPayload } from '@harness/sdk';
import type { AccessScope } from '../access/index.ts';
import type { HubServices } from '../boot/index.ts';
import type { Catalog } from '../catalog/index.ts';
import { agentNames, listHookExplains, listInjections } from '../catalog/injections.ts';
import { hookTag } from '../chat/enrich.ts';
import type { FnsForPrompt } from '../fns/index.ts';
import type { DynamicContext, TokenEstimates } from '../contextor/index.ts';
import { fitInjected, gatherInjected, injectedBlock, type FittedInjected, type InjectedGather, type InjectedItem } from '../contextor/injected.ts';
import { modeChoice } from '../contextor/planner.ts';
import { modeNames } from '../contextor/modes.ts';
import { DEFAULT_CHARS_PER_TOKEN, rawTokens } from '../contextor/tokens.ts';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../store/rows.ts';

/** The order of a hook's `explains` (as the planner's): after its system's items at the default order. */
export const HOOK_EXPLAINS_ORDER = 100;

/** What is known of one agent for its Injected tab. */
export interface AgentFacts {
  readonly name: QualifiedName;
  /** How it takes its section; absent is every item in full, uncapped. */
  readonly injected: AgentInjected | undefined;
  /** The chat mode shown: the query's, else the agent's own, else the hub's default. */
  readonly mode: ChatModeType;
  /** The model it names, when it names one model (not a category or automatic choice). */
  readonly model?: string | undefined;
}

/** How an agent's view writes text for the model and sizes it. */
export interface ViewText {
  /** Text as the model reads it (fn names rendered). */
  readonly render: (text: string) => string;
  /** Tokens of a text. */
  readonly tokens: (text: string) => number;
}

/** An item's text at a detail, as the planner takes it: its summary when asked and it has one, else its full text. */
function textAt(item: InjectedItem, detail: 'full' | 'summary'): string {
  return detail === 'summary' ? item.summary ?? item.full : item.full;
}

/**
 * The views of one agent's items, in the order it reads them, from what the planner gathered and fitted: an item in
 * the section at the detail it got there (and the tokens the planner counted for it); one listed under `<more_ctx>`
 * or cut as `no-fit`; one left out with the planner's reason. `declared` gives the text, target and order of items the
 * planner left out (it gives only why).
 */
export function agentInjectionViews(input: {
  readonly agent: AgentFacts;
  readonly gathered: InjectedGather;
  readonly fitted: FittedInjected | undefined;
  readonly declared: ReadonlyMap<string, InjectedItem>;
  readonly settings: ReadonlyMap<string, InjectionSetting>;
  readonly text: ViewText;
}): InjectionView[] {
  const { agent, gathered, fitted, declared, settings, text } = input;
  const detail = agent.injected === undefined || agent.injected === 'none' ? 'full' : agent.injected.detail;
  const placed = new Map((fitted?.placed ?? []).map((p) => [p.item.name, p]));
  const noFit = new Map((fitted?.noFit ?? []).map((left) => [left.name, left]));
  const left = new Map(gathered.leftOut.map((item) => [item.name, item]));
  const items = [...gathered.items, ...gathered.leftOut.flatMap((item) => { const found = declared.get(item.name); return found === undefined ? [] : [found]; })]
    .sort((a, b) => a.order - b.order || a.system.localeCompare(b.system) || rank(a) - rank(b) || a.name.localeCompare(b.name));
  return items.map((item) => {
    const setting = settings.get(item.name);
    const p = placed.get(item.name);
    const at = p === undefined || p.detail === 'listed' ? detail : p.detail;
    const leftOut = ((): { why: InjectionLeftOut; reason: string } | undefined => {
      if (agent.injected === 'none') { return { why: 'off', reason: 'this agent takes no injected context (its `injected` is `none`)' }; }
      const out = left.get(item.name) ?? noFit.get(item.name);
      if (out !== undefined) { return { why: out.why, reason: out.reason }; }
      if (p?.detail === 'listed') { return { why: 'no-fit', reason: 'only a line under <more_ctx> (loadable by name): it did not fit the injected section at its summary' }; }
      return undefined;
    })();
    const tokens = p !== undefined && p.detail !== 'listed' ? p.tokens : text.tokens(text.render(injectedBlock(item.title, textAt(item, at))));
    return InjectionView.parse({
      agent: agent.name, context: item.name, source: item.source, system: item.system, via: item.via, title: item.title, detail: at,
      text: text.render(textAt(item, at)), tokens, order: item.order, on: setting?.on ?? true,
      ...(leftOut === undefined ? {} : { leftOut }),
      ...(setting === undefined ? {} : { switched: { by: setting.by, at: setting.at } }),
    });
  });
}

/** A context item before a hook's `explains` at the same order and system (as the planner sorts). */
function rank(item: InjectedItem): number {
  return item.source.type === 'context' ? 0 : 1;
}

/** What the views are worked out from: the planner's own inputs. */
export interface InjectionDeps {
  readonly store: HubStore;
  readonly catalog: Pick<Catalog, 'entries' | 'fn' | 'availability' | 'modelNames'>;
  /** Dynamic context's text, asked of its system for the items that go in. */
  readonly dynamic: DynamicContext;
  /** Fns' modes, for a fn setting (`fnMode`). */
  readonly fns?: Pick<FnsForPrompt, 'modes'> | undefined;
  /** Each model's calibrated estimator, for an agent that names one model. */
  readonly tokens?: Pick<TokenEstimates, 'forModel'> | undefined;
  /** What the admin may see. */
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  readonly clock: () => number;
}

/** The hub's services as the views use them. */
export function injectionDeps(hub: Pick<HubServices, 'store' | 'catalog' | 'contextor' | 'clock' | 'access' | 'fns'>): InjectionDeps {
  return {
    store: hub.store, catalog: hub.catalog, dynamic: hub.contextor.dynamic, fns: hub.fns.facts, tokens: hub.contextor.tokens,
    access: (actor) => hub.access.scope(actor), clock: hub.clock,
  };
}

/** An agent fn's payload, or nothing known when it doesn't parse. */
function payloadOf(fn: FnRecord): Pick<LlmPayload, 'injected' | 'mode' | 'contextor' | 'model'> {
  try { return parseValue(LlmPayloadType, fn.decl.payload); } catch { return {}; }
}

/** An agent's facts, read off its fn's payload; the chat mode is the query's when it names one. */
function agentFacts(fn: FnRecord, mode: ChatModeType | undefined): AgentFacts {
  const payload = payloadOf(fn);
  const injected = AgentInjected.safeParse(payload.injected);
  const choice = ModelChoice.optional().safeParse(payload.model);
  const model = choice.success && choice.data !== undefined && 'model' in choice.data ? choice.data.model : undefined;
  return { name: fn.name, injected: injected.success ? injected.data : undefined, mode: mode ?? modeChoice(undefined, payload).mode.type, model };
}

/** Every item as declared that reaches the agent, by name: its target, order and text, for showing it when it is left out. */
async function declaredFor(deps: InjectionDeps, agent: QualifiedName, settings: ReadonlyMap<string, InjectionSetting>): Promise<Map<string, InjectedItem>> {
  const out = new Map<string, InjectedItem>();
  for (const injection of await listInjections(deps.store, { agent })) {
    const record = await deps.store.table('context').get(injection.context);
    if (record === undefined) { continue; }
    const { decl } = record;
    out.set(injection.context, {
      name: injection.context, source: { type: 'context' }, system: injection.system,
      via: injection.targets.find((target) => target.agents.includes(agent))?.target ?? agent,
      title: injection.title, order: settings.get(injection.context)?.order ?? injection.inject.order, full: decl.content ?? decl.summary ?? decl.description,
      summary: decl.summary, fns: injection.fns, record, dynamic: injection.dynamic,
    });
  }
  for (const hook of await listHookExplains(deps.catalog, deps.store)) {
    out.set(hook.hook, {
      name: hook.hook, source: { type: 'hook', hook: hook.hook }, system: hook.system, via: agent, title: `The <${hookTag(hook.hook)}> block`,
      order: settings.get(hook.hook)?.order ?? HOOK_EXPLAINS_ORDER, full: hook.explains, summary: undefined, fns: [], dynamic: false,
    });
  }
  return out;
}

/** The admin's settings for one agent, by item. */
async function settingsOf(store: HubStore, agent: QualifiedName): Promise<Map<string, InjectionSetting>> {
  return new Map((await allRows(store.table('injectionSettings'), { where: { agent } })).map((row) => [row.context, row]));
}

/** The chat a preview stands for: a new chat with this agent, every system on, the fn setting asked for. */
export function previewChat(agent: QualifiedName, fnMode: ChatFnMode | undefined) {
  return { id: mintId('session'), agent, systems: 'all' as const, ...(fnMode === undefined ? {} : { fnMode }) };
}

/** One agent's views, as the planner would build its section for a new chat with it. */
async function viewsOfAgent(deps: InjectionDeps, fn: FnRecord, viewer: ActorId, access: AccessScope, query: InjectionsQuery): Promise<InjectionView[]> {
  const agent = agentFacts(fn, query.mode);
  const settings = await settingsOf(deps.store, agent.name);
  const names = modeNames(agent.mode, await deps.catalog.modelNames());
  const estimator = agent.model === undefined || deps.tokens === undefined ? undefined : await deps.tokens.forModel(agent.model).catch(() => undefined);
  const text: ViewText = { render: (t) => names.text(t), tokens: (t) => estimator?.text(t) ?? rawTokens(t.length, DEFAULT_CHARS_PER_TOKEN) };
  const [gathered, declared] = await Promise.all([
    gatherInjected(deps, { agent: fn, session: previewChat(agent.name, query.fnMode), access, user: viewer, mode: agent.mode }),
    declaredFor(deps, agent.name, settings),
  ]);
  const all = [...gathered.items, ...declared.values()];
  await names.learn(all.flatMap((item) => [item.title, item.full, item.summary ?? '']));
  const injected = agent.injected;
  const fitted = injected === 'none' ? undefined : fitInjected(gathered.items, {
    detail: injected?.detail ?? 'full', room: injected?.maxTokens ?? Number.POSITIVE_INFINITY, estimator: { text: text.tokens }, render: text.render,
  });
  return agentInjectionViews({ agent, gathered, fitted, declared, settings, text });
}

/** Refuse a name that is no agent. */
function needAgent(agents: readonly QualifiedName[], agent: QualifiedName): void {
  if (!agents.includes(agent)) { throw reject(404, 'NO_AGENT', `${agent} is not an agent (a hub/llm fn)`); }
}

/**
 * What `hub/ctx_injections_list` answers: the injections reaching one agent (`agent`), one item's in every agent it
 * reaches (`context`, with its targets and the agents each hits), both, or every injection there is; as a new chat
 * in `mode` with `fnMode` would get them (defaults: the agent's mode, no fn setting).
 */
export async function injectionsPage(deps: InjectionDeps, query: InjectionsQuery, viewer: ActorId): Promise<InjectionsPage> {
  const [agents, access] = await Promise.all([agentNames(deps.store), deps.access(viewer)]);
  if (query.agent !== undefined) { needAgent(agents, query.agent); }
  let targets: InjectTargetView[] = [];
  if (query.context !== undefined) {
    const [injection] = await listInjections(deps.store, { context: query.context });
    const hook = injection === undefined ? (await listHookExplains(deps.catalog, deps.store)).find((h) => h.hook === query.context) : undefined;
    if (injection === undefined && hook === undefined) {
      throw reject(404, 'NO_INJECTION', `${query.context} is not injected anywhere: it is no context item with \`inject\`, nor a hook with \`explains\``);
    }
    // a hook's `explains` goes into whichever agent a chat runs: every agent
    targets = injection?.targets ?? [InjectTargetView.parse({ target: '*', agents })];
  }
  const reached = query.agent !== undefined ? [query.agent] : query.context !== undefined ? [...new Set(targets.flatMap((target) => target.agents))].sort() : agents;
  const injections: InjectionView[] = [];
  for (const name of reached) {
    const fn = await deps.catalog.fn(name);
    if (fn === undefined) { continue; }
    const views = await viewsOfAgent(deps, fn, viewer, access, query);
    injections.push(...(query.context === undefined ? views : views.filter((view) => view.context === query.context)));
  }
  return { injections, targets };
}

/**
 * What `hub/ctx_injection_set` does: switch one item on or off for one agent and/or give it another order there
 * (`order: null` goes back to the declared order). Only a setting that differs from the default is kept: on, at the
 * declared order, the row goes. Answers the item's view in that agent as it is now.
 */
export async function setInjection(deps: InjectionDeps, data: SetInjection, by: ActorId): Promise<InjectionView> {
  if (data.on === undefined && data.order === undefined) { throw reject(422, 'NOTHING_TO_SET', 'say `on`, `order`, or both'); }
  const key = { agent: data.agent, context: data.context };
  const before = await injectionsPage(deps, key, by);
  if (before.injections.length === 0) { throw reject(404, 'NO_INJECTION', `${data.context} is not injected into ${data.agent}: none of its targets hits it`); }
  const table = deps.store.table('injectionSettings');
  const existing = await table.get(key);
  const on = data.on ?? existing?.on ?? true;
  const order = data.order === null ? undefined : data.order ?? existing?.order;
  if (on && order === undefined) {
    await table.remove(key);
  } else {
    await table.put(InjectionSetting.parse({ ...key, on, ...(order === undefined ? {} : { order }), by, at: deps.clock() }));
  }
  const [view] = (await injectionsPage(deps, key, by)).injections;
  if (view === undefined) { throw reject(404, 'NO_INJECTION', `${data.context} is not injected into ${data.agent}`); }
  return view;
}
