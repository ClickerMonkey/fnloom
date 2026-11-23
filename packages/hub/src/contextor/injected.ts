/**
 * An agent's injected section (`{{injectedContext}}`): the context items whose `inject` targets hit the agent, and the
 * hooks' `explains` of the session's systems, put into its system prompt as part of the fixed region.
 *
 * - **What reaches an agent** (`gatherInjected`): every item the catalog lists for it (`listInjections`, its targets
 *   matched by core's `targetHits`), in order (the admin's per-agent order from `injectionSettings`, else the item's
 *   `inject.order`, then its key), and, for the session's own agent, each hook of the session's systems that says what
 *   its block means. Each is in, or left out with one of `INJECTION_LEFT_OUT`'s reasons, the first that applies:
 *   waiting for review (`pending`), `declined`, switched off for this agent or by itself (`off`), its system off or
 *   not in the chat (`system-off`), for the other chat mode (`mode`), a fn it brings or requires that can't be used
 *   here (`fns-unusable`: off, held, unseen, beyond the chat's fn setting). Then each item that goes in takes out the
 *   items it replaces (`InjectDecl.replaces`: `replaced`, naming what replaces it), so an item left out for any other
 *   reason replaces nothing and what it names is back. Hub-made context the person can't see (another person's
 *   memory) is not theirs to be told about, so it is skipped without a reason.
 * - **How it fits** (`fitInjected`): each item at the agent's detail (`full`, or `summary` for a small window), as its
 *   title as a heading and then its text, within `room` tokens; when the section doesn't fit, items fall back from
 *   the highest order down, first to their summary, then to a line under `<more_ctx>` (loadable by name), then out
 *   (`no-fit`). Every fallback is a `cut` entry, so nothing is cut silently.
 * - **Where it goes** (`placeInjected`): at `{{injectedContext}}` in the agent's instructions, or straight after them.
 *
 * The section is pure text the hub fills in itself, never a Handlebars value it escapes. The planner works it out at
 * the start of each turn and keeps it for the turn's steps (`FixedRegionStamp`).
 */
import { createHash } from 'node:crypto';
import {
  MODE_RANK, flow, mapConcurrent, seesOrigin, targetHits, type AgentTargetDecl, type ChatModeType, type ContextRecord, type FnMode, type FnRecord, type InjectionLeftOut, type InjectionSetting,
  type InjectionSource, type QualifiedName, type Session, type SystemName,
} from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import { listHookExplains, listInjections } from '../catalog/injections.ts';
import { offReason } from '../chat/announce.ts';
import { hookTag } from '../chat/enrich.ts';
import { allowsSystem } from '../chat/support.ts';
import type { FnsForPrompt } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../store/rows.ts';
import type { Cut } from './choose.ts';
import type { DynamicAsk, DynamicContext, TokenEstimator } from './index.ts';
import { listedContextElement, moreContext } from './render.ts';
import { fnRefusal } from './views.ts';

/** Where an agent's instructions want the injected section. Spaces inside the braces are allowed. */
export const INJECTED_PLACEHOLDER = /\{\{\s*injectedContext\s*\}\}/g;

/** One item that reaches an agent and may go in its injected section. */
export interface InjectedItem {
  /** The context item's key, or the hook's name for a hook's `explains`. */
  readonly name: QualifiedName;
  readonly source: InjectionSource;
  readonly system: SystemName;
  /** The target that took it in (`hub/chat*`), or the agent itself for a hook's `explains`. */
  readonly via: AgentTargetDecl;
  /** Its heading. */
  readonly title: string;
  /** Its order in this agent: the admin's, else the declared one. */
  readonly order: number;
  /** Its text in full, and its summary when it has one of its own. */
  readonly full: string;
  readonly summary: string | undefined;
  /** The fns it brings: they join the agent's starting tools while it is shown. */
  readonly fns: readonly QualifiedName[];
  /** The items it takes out of the section while it goes in (`InjectDecl.replaces`); none for a hook's `explains`. */
  readonly replaces: readonly QualifiedName[];
  /** The context record (for its `<more_ctx>` line); absent for a hook's `explains`, which can't be loaded by name. */
  readonly record?: ContextRecord;
  /** Written by its system each turn: its text can change. */
  readonly dynamic: boolean;
}

/** An item that reaches the agent but isn't in its section, and why. */
export interface LeftOutItem {
  readonly name: QualifiedName;
  readonly title: string;
  readonly why: InjectionLeftOut;
  readonly reason: string;
}

/** What reaches one agent: the items that may go in, in order, and the ones left out with why. */
export interface InjectedGather {
  readonly items: readonly InjectedItem[];
  readonly leftOut: readonly LeftOutItem[];
}

/** Who and what an agent's injected section is gathered for. */
export interface InjectedFor {
  readonly agent: FnRecord;
  /** The chat (only its id, agent, systems and fn setting are read: the admin's preview passes a chat that isn't stored). */
  readonly session: Pick<Session, 'id' | 'agent' | 'systems' | 'fnMode'> | undefined;
  readonly access: AccessScope;
  readonly user: DynamicAsk['actor'];
  readonly person?: DynamicAsk['user'];
  /** The chat mode the prompt is in (an item with `mode` goes only into that one). */
  readonly mode: ChatModeType;
}

/** What gathering reads. */
export interface InjectedDeps {
  readonly store: HubStore;
  readonly catalog: Pick<Catalog, 'fn' | 'entries' | 'availability'>;
  readonly dynamic: DynamicContext;
  /** Fns' modes, for the chat's fn setting (none: every fn counts as `write`). */
  readonly fns?: Pick<FnsForPrompt, 'modes'> | undefined;
  /** How many items are worked out at once (`HARNESS_CONTEXT_PARALLEL`: a dynamic one is written by its system); all at once when unset. */
  readonly parallel?: number | undefined;
}

/** The default order of a hook's `explains`: after its system's items at the default order. */
const HOOK_ORDER = 100;

/**
 * Everything that reaches an agent, each in or left out with why (see the module's doc). The order is the section's:
 * the admin's per-agent order, else the declared one; ties by system, a context item before a hook's `explains`, then key.
 */
export async function gatherInjected(deps: InjectedDeps, at: InjectedFor): Promise<InjectedGather> {
  const agent = at.agent.name;
  const [injections, settingRows, systems] = await Promise.all([
    listInjections(deps.store, { agent }),
    allRows(deps.store.table('injectionSettings'), { where: { agent } }),
    allRows(deps.store.table('systems')),
  ]);
  const settings = new Map<string, InjectionSetting>(settingRows.map((row) => [row.context, row]));
  const systemRows = new Map(systems.map((row) => [row.name, row]));
  const chat = at.session ?? { systems: 'all' as const };
  const systemOff = (system: SystemName): string | undefined => {
    if (system === HUB_SYSTEM) return undefined;
    const row = systemRows.get(system);
    if (row === undefined || !at.access.seesSystem(system)) return `${system} is not installed`;
    const why = offReason(row, chat);
    return why === undefined ? undefined : why === 'chat' ? `this chat does not use ${system}` : `${system} is off (${why})`;
  };
  type Candidate = { item: InjectedItem; left?: Omit<LeftOutItem, 'name' | 'title'> };
  const limit = { limit: deps.parallel };

  /** A context injection as a candidate: undefined when the asker may not see it. */
  const contextCandidate = async (injection: (typeof injections)[number]): Promise<Candidate | undefined> => {
    const stored = await deps.store.table('context').get(injection.context);
    if (stored === undefined || !at.access.seesContext(stored) || !seesOrigin(stored.origin, { actor: at.user, session: at.session?.id })) return undefined;
    const setting = settings.get(injection.context);
    const via = injection.inject.into.find((target) => targetHits(target, agent)) ?? agent;
    const order = setting?.order ?? injection.inject.order;
    const left = await leftOutOf({
      review: injection.review, setting, off: injection.off, system: systemOff(injection.system), mode: injection.inject.mode,
      needs: [...injection.fns, ...injection.inject.requires],
    }, deps, at);
    // the text only for what goes in: a dynamic item is asked of its system then, never for one left out
    const record = left === undefined ? await deps.dynamic.resolve(stored, { session: at.session?.id, actor: at.user, user: at.person }) : stored;
    const { decl } = record;
    return {
      item: {
        name: injection.context, source: { type: 'context' }, system: injection.system, via, title: injection.title, order,
        full: decl.content ?? decl.summary ?? decl.description, summary: decl.summary, fns: injection.fns,
        replaces: injection.inject.replaces ?? [], record, dynamic: injection.dynamic,
      },
      ...(left === undefined ? {} : { left }),
    };
  };

  /** A hook's `explains` as a candidate: undefined when the chat doesn't use its system or the asker can't see it. */
  const hookCandidate = async (hook: Awaited<ReturnType<typeof listHookExplains>>[number]): Promise<Candidate | undefined> => {
    if (at.session === undefined || !allowsSystem(at.session, hook.system) || !at.access.seesSystem(hook.system)) return undefined;
    const setting = settings.get(hook.hook);
    const available = await deps.catalog.availability(hook.hook);
    const left = await leftOutOf({
      review: hook.review, setting, off: available !== true && available.unavailable === 'disabled', system: systemOff(hook.system), needs: [],
    }, deps, at);
    const tag = hookTag(hook.hook);
    return {
      item: {
        name: hook.hook, source: { type: 'hook', hook: hook.hook }, system: hook.system, via: agent, title: `The <${tag}> block`,
        order: setting?.order ?? HOOK_ORDER, full: hook.explains, summary: undefined, fns: [], replaces: [], dynamic: false,
      },
      ...(left === undefined ? {} : { left }),
    };
  };

  // the context items (a dynamic one written by its system) and the hooks' explains are worked out together
  const found = await flow()
    .step('context', () => mapConcurrent(injections, contextCandidate, limit))
    // a hook's blocks go into the session's own agent's messages, so only it is told what they mean
    .step('hooks', async () => (at.session !== undefined && at.session.agent === agent ? mapConcurrent(await listHookExplains(deps.catalog, deps.store), hookCandidate, limit) : []))
    .run();
  const candidates = withReplaced([...found.context, ...found.hooks].filter((candidate) => candidate !== undefined));

  candidates.sort((a, b) => a.item.order - b.item.order || a.item.system.localeCompare(b.item.system)
    || sourceRank(a.item) - sourceRank(b.item) || a.item.name.localeCompare(b.item.name));
  return {
    items: candidates.flatMap((c) => (c.left === undefined ? [c.item] : [])),
    leftOut: candidates.flatMap((c) => (c.left === undefined ? [] : [{ name: c.item.name, title: c.item.title, ...c.left }])),
  };
}

/**
 * The candidates with each item that goes in taking out the ones it replaces (`replaced`, naming what replaces it). One
 * pass over what goes in before any replacing, so an item replaced by another still replaces what it names.
 */
function withReplaced<C extends { readonly item: InjectedItem; readonly left?: Omit<LeftOutItem, 'name' | 'title'> }>(candidates: readonly C[]): C[] {
  const by = new Map<QualifiedName, InjectedItem[]>();
  for (const { item, left } of candidates) {
    if (left !== undefined) continue;
    for (const name of item.replaces) if (name !== item.name) by.set(name, [...by.get(name) ?? [], item]);
  }
  if (by.size === 0) return [...candidates];
  return candidates.map((candidate) => {
    const replacers = by.get(candidate.item.name);
    if (candidate.left !== undefined || replacers === undefined) return candidate;
    const names = replacers.map((item) => `${item.title} (${item.name})`).join(' and ');
    return { ...candidate, left: { why: 'replaced', reason: `replaced by ${names}, which says what is true instead` } };
  });
}

/** A context item before a hook's `explains` at the same order and system. */
function sourceRank(item: InjectedItem): number {
  return item.source.type === 'context' ? 0 : 1;
}

/** The facts that decide whether an item is left out. */
interface Facts {
  readonly review: 'approved' | 'pending' | 'declined';
  readonly setting: InjectionSetting | undefined;
  readonly off: boolean;
  /** Why its system is off here; undefined when it is on. */
  readonly system: string | undefined;
  readonly mode?: ChatModeType | undefined;
  /** Its fns and the fns it requires: every one must be usable. */
  readonly needs: readonly QualifiedName[];
}

/** Why an item is left out, the first reason that applies; undefined when it goes in. */
async function leftOutOf(facts: Facts, deps: InjectedDeps, at: InjectedFor): Promise<Omit<LeftOutItem, 'name' | 'title'> | undefined> {
  if (facts.review === 'pending') return { why: 'pending', reason: 'waiting for an admin to review it' };
  if (facts.review === 'declined') return { why: 'declined', reason: 'an admin declined it' };
  if (facts.setting?.on === false) return { why: 'off', reason: 'switched off for this agent by an admin' };
  if (facts.off) return { why: 'off', reason: 'switched off' };
  if (facts.system !== undefined) return { why: 'system-off', reason: facts.system };
  if (facts.mode !== undefined && facts.mode !== at.mode) return { why: 'mode', reason: `only for the ${facts.mode} mode; this chat is in ${at.mode}` };
  const unusable = await unusableFn([...new Set(facts.needs)], deps, at);
  if (unusable !== undefined) return { why: 'fns-unusable', reason: unusable };
  return undefined;
}

/** Why one of these fns can't be used in this chat, or undefined when all of them can. */
async function unusableFn(names: readonly QualifiedName[], deps: InjectedDeps, at: InjectedFor): Promise<string | undefined> {
  if (names.length === 0) return undefined;
  const fnMode = at.session?.fnMode;
  if (fnMode === 'none') return 'this chat uses no fns';
  for (const name of names) {
    const block = fnRefusal(await deps.catalog.fn(name), at.session, at.access);
    if (block !== undefined) return `${name}: ${block.reason}`;
  }
  if (fnMode === 'read' || fnMode === 'write' || fnMode === 'delete') {
    const modes: ReadonlyMap<QualifiedName, FnMode> = deps.fns === undefined ? new Map() : await deps.fns.modes(names);
    const over = names.find((name) => MODE_RANK[modes.get(name) ?? 'write'] > MODE_RANK[fnMode]);
    if (over !== undefined) return `${over}: this chat allows fns up to ${fnMode}`;
  }
  return undefined;
}

// ─── Fitting ──────────────────────────────────────────────────────────────────

/** How far an item has fallen back: its detail in the section, or out. */
type Level = 'full' | 'summary' | 'listed' | 'out';

/** An item as the section holds it. */
export interface PlacedItem {
  readonly item: InjectedItem;
  readonly detail: 'full' | 'summary' | 'listed';
  /** What its part of the section costs. */
  readonly tokens: number;
}

/** The injected section, fitted. */
export interface FittedInjected {
  /** The section's text as the model reads it ('' for none). */
  readonly text: string;
  readonly tokens: number;
  readonly placed: readonly PlacedItem[];
  /** Items that didn't fit at all. */
  readonly noFit: readonly LeftOutItem[];
  /** Every fallback, for the selection report. */
  readonly cut: readonly Cut[];
}

/** How to fit a section. */
export interface FitOptions {
  /** The detail the agent takes its items at. */
  readonly detail: 'full' | 'summary';
  /** The most tokens the section may take. */
  readonly room: number;
  readonly estimator: Pick<TokenEstimator, 'text'>;
  /** Text for the model (fn names as it calls them here). */
  readonly render: (text: string) => string;
}

/** An item's text at a detail: its summary when asked and it has one, else its full text. */
function textAt(item: InjectedItem, detail: 'full' | 'summary'): string {
  return detail === 'summary' ? item.summary ?? item.full : item.full;
}

/** One item's block: its title as a heading, then its text. */
export function injectedBlock(title: string, text: string): string {
  return `## ${title}\n\n${text.trim()}`;
}

/** The section's text for items at their levels: each shown block in order, then the listed ones under `<more_ctx>`. */
function sectionText(items: readonly InjectedItem[], levels: readonly Level[], render: (text: string) => string): string {
  const blocks: string[] = [];
  const listed: ContextRecord[] = [];
  items.forEach((item, i) => {
    const level = levels[i];
    if (level === 'full' || level === 'summary') blocks.push(render(injectedBlock(item.title, textAt(item, level))));
    else if (level === 'listed' && item.record !== undefined) listed.push(item.record);
  });
  const more = listed.length === 0 ? '' : render(moreContext(listed));
  return [...blocks, more].filter((part) => part !== '').join('\n\n');
}

/**
 * The section within `room` tokens. Every item starts at the agent's detail; while the section is over, items fall
 * back from the highest order down: all to their summaries first (one with no summary of its own keeps its text),
 * then to `<more_ctx>` lines where a line is smaller than what it shows (a hook's `explains` has no line), then out,
 * the highest order first.
 */
export function fitInjected(items: readonly InjectedItem[], options: FitOptions): FittedInjected {
  const levels: Level[] = items.map(() => options.detail);
  const measure = (): number => {
    const text = sectionText(items, levels, options.render);
    return text === '' ? 0 : options.estimator.text(text);
  };
  const cut: Cut[] = [];
  const noFit: LeftOutItem[] = [];
  const label = (item: InjectedItem): string => `injected ${item.title} (${item.name})`;
  const cost = (item: InjectedItem, level: Level): number => {
    if (level === 'out') return 0;
    if (level === 'listed') return item.record === undefined ? 0 : options.estimator.text(listedContextElement(item.record).toString());
    return options.estimator.text(options.render(injectedBlock(item.title, textAt(item, level))));
  };
  let total = measure();
  const steps: ReadonlyArray<{ readonly to: Level; readonly can: (item: InjectedItem, level: Level) => boolean; readonly why: string }> = [
    { to: 'summary', can: (item, level) => level === 'full' && item.summary !== undefined && item.summary !== item.full, why: 'at its summary, to fit the injected section' },
    // a line only where it is smaller than what the item shows now: a short summary stays a summary
    { to: 'listed', can: (item, level) => (level === 'full' || level === 'summary') && item.record !== undefined && cost(item, 'listed') < cost(item, level), why: 'as a line under <more_ctx>, to fit the injected section' },
    { to: 'out', can: (_item, level) => level !== 'out', why: 'left out of the injected section: it did not fit' },
  ];
  for (const step of steps) {
    for (let i = items.length - 1; i >= 0 && total > options.room; i--) {
      const item = items[i];
      const level = levels[i];
      if (item === undefined || level === undefined || !step.can(item, level)) continue;
      levels[i] = step.to;
      total = measure();
      cut.push({ what: label(item), why: step.why });
      if (step.to === 'out') noFit.push({ name: item.name, title: item.title, why: 'no-fit', reason: `did not fit the injected section (${options.room.toLocaleString('en-US')} tokens)` });
    }
  }
  const placed: PlacedItem[] = [];
  items.forEach((item, i) => {
    const level = levels[i];
    if (level === undefined || level === 'out') return;
    placed.push({ item, detail: level, tokens: cost(item, level) });
  });
  const text = sectionText(items, levels, options.render);
  return { text, tokens: total, placed, noFit, cut };
}

/** The fns the shown items bring (full or summary; a `<more_ctx>` line brings none), in order, each once. */
export function injectedFns(placed: readonly PlacedItem[]): QualifiedName[] {
  return [...new Set(placed.filter((p) => p.detail !== 'listed').flatMap((p) => p.item.fns))];
}

/** The context items the section shows (full or summary): already in the prompt, so no contextor shows them again. */
export function injectedShown(placed: readonly PlacedItem[]): QualifiedName[] {
  return placed.filter((p) => p.detail !== 'listed' && p.item.source.type === 'context').map((p) => p.item.name);
}

/**
 * The agent's instructions as a template with the section in its place: `{{injectedContext}}` becomes the raw value
 * `{{{injectedContext}}}` (filled by the hub, never escaped or read as a template); without the placeholder the
 * section follows the instructions.
 */
export function injectedTemplate(instructions: string): string {
  return hasPlaceholder(instructions)
    ? instructions.replace(INJECTED_PLACEHOLDER, '{{{injectedContext}}}')
    : `${instructions}{{#if injectedContext}}\n\n{{{injectedContext}}}{{/if}}`;
}

/** The instructions with the section put in (for estimates and the fixed region's hash). */
export function placeInjected(instructions: string, section: string): string {
  if (hasPlaceholder(instructions)) return instructions.replace(INJECTED_PLACEHOLDER, () => section);
  return section === '' ? instructions : `${instructions}\n\n${section}`;
}

function hasPlaceholder(instructions: string): boolean {
  return new RegExp(INJECTED_PLACEHOLDER.source).test(instructions);
}

/** The hash of a fixed region's text, for `FixedRegionStamp`. */
export function fixedHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
