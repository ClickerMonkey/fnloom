/**
 * How a system's review reads (build 7): its stage, the items an admin switched off, each fn joined with the facts the
 * hub worked out, its grants as plain rows, its refusals in words, its checks' counts, and its pending changes: grouped
 * by section, each drawn with its tab's view (a fn's facts before and after, a type, a context item's prose as a word
 * diff, the grants as a delta), with a line diff of the raw declaration behind a toggle. Pure, so it is tested alone.
 */
import {
  effectsLine, GinTypeDef, ITEM_SECTIONS, qualify, SystemGrants, type ChangeRef, type ClientAssets, type ContractChange, type DeclaredFnFacts, type FnChangeFacts, type FnDecl, type FnFacts,
  type FnMode, type GrantsMove, type HubCapability, type InstallChecks, type ItemRef, type ItemSection, type Json, type PreviewPart, type QualifiedName, type RefusalRecord,
  type RefusalRule, type ReviewFlag, type ReviewFlagKind, type SystemName, type SystemReview, type SystemStage,
} from '@harness/core';
import { formatDuration } from '../../chat/logic/format.ts';
import type { IconName, Tone } from '../../ui/index.ts';
import { PART_SECTION_WORDS, type StatusLook } from './systems.ts';

/** Every stage's look. */
export const STAGE_LOOK = {
  installed: { tone: 'warn', word: 'Installed, not live', live: false },
  live: { tone: 'ok', word: 'Live', live: false },
} as const satisfies Record<SystemStage, StatusLook>;

/** What each stage means for the system, in one line. */
export const STAGE_ABOUT = {
  installed: 'Paired and connected, but nothing it offers is used yet. Review it, switch off what you don’t want, and go live.',
  live: 'Everything switched on below is in use.',
} as const satisfies Record<SystemStage, string>;

/** A switchable item's key: its section and name. */
export function itemKey(item: ItemRef): string {
  return `${item.section}:${item.name}`;
}

/** The keys of the items switched off, for quick lookups. */
export function offKeys(off: readonly ItemRef[]): ReadonlySet<string> {
  return new Set(off.map(itemKey));
}

/** The off list after switching one item on or off. */
export function withSwitch(off: readonly ItemRef[], item: ItemRef, on: boolean): ItemRef[] {
  const rest = off.filter((other) => itemKey(other) !== itemKey(item));
  return on ? rest : [...rest, { section: item.section, name: item.name }];
}

/** One of a system's fns as the review shows it. */
export interface FnReview {
  readonly name: QualifiedName;
  readonly decl: FnDecl;
  /** What the hub worked out about it; absent when it has no facts yet. */
  readonly facts: FnFacts | undefined;
  /** What it changes in the hub, in one line ("Creates fns (database/query)."), when anything. */
  readonly effects: string | undefined;
  readonly on: boolean;
}

/** A system's fns in its contract's order, each with its facts and whether it is switched on. */
export function fnReviews(review: Pick<SystemReview, 'system' | 'manifest' | 'facts' | 'off'>): readonly FnReview[] {
  const facts = new Map(review.facts.map((fact) => [fact.fn, fact]));
  const off = offKeys(review.off);
  return review.manifest.fns.map((decl) => {
    const name = qualify(review.system, decl.name);
    const found = facts.get(name);
    const effects = effectsLine(found?.registry ?? decl.effects?.registry ?? []);
    return { name, decl, facts: found, effects, on: !off.has(itemKey({ section: 'fns', name })) };
  });
}

/** One context item or type the system declares, as the review lists it. */
export interface DeclaredItem {
  readonly section: Extract<ItemSection, 'context' | 'types'>;
  readonly name: QualifiedName;
  readonly title: string;
  readonly about: string;
  /** Added while running rather than declared in the contract. */
  readonly runtime: boolean;
  readonly on: boolean;
}

/** The context items and types a system's contract (and its running additions) declare, each with its switch. */
export function declaredItems(review: Pick<SystemReview, 'system' | 'manifest' | 'off'>, section: DeclaredItem['section']): readonly DeclaredItem[] {
  const off = offKeys(review.off);
  const runtime = new Set(review.manifest.runtime?.[section] ?? []);
  const entries = section === 'context'
    ? review.manifest.context.map((decl) => ({ local: decl.name, title: decl.title ?? decl.name, about: decl.description }))
    : review.manifest.types.map((decl) => ({ local: decl.name, title: decl.name, about: decl.description }));
  return entries.map(({ local, title, about }) => {
    const name = qualify(review.system, local);
    return { section, name, title, about, runtime: runtime.has(local), on: !off.has(itemKey({ section, name })) };
  });
}

/** What each hub capability lets a system do, in plain words. */
export const CAPABILITY_WORDS = {
  ai: 'Call models through the hub',
  embed: 'Make embeddings',
  resources: 'Serve and read resources',
  fns: 'Call other fns',
  search: 'Search fns and examples',
  decide: 'Ask the decision model',
  approvals: 'Ask for approvals',
  connections: 'Update people’s connections',
  settings: 'Read settings',
  state: 'Keep state in the hub',
  data: 'Read and write records in the hub',
} as const satisfies Record<HubCapability, string>;

/** One row of a system's grants. */
export interface GrantRow {
  readonly key: 'hub' | 'roles' | 'models' | 'spend' | 'secrets' | 'calls' | 'network' | 'read' | 'write';
  readonly label: string;
  /** The values granted; empty reads as "none". */
  readonly values: readonly string[];
}

/** A system's grants as rows; a system that declares none gets the hub's base only. */
export function grantRows(grants: SystemGrants | undefined, money: (usd: number) => string): readonly GrantRow[] {
  if (grants === undefined) { return []; }
  const rows: GrantRow[] = [{ key: 'hub', label: 'Hub calls', values: grants.hub.map((capability) => CAPABILITY_WORDS[capability]) }];
  const models = grants.models;
  if (models !== undefined) {
    rows.push({ key: 'roles', label: 'Model roles', values: models.roles ?? ['Any role'] });
    if (models.models !== undefined) { rows.push({ key: 'models', label: 'Models by name', values: models.models }); }
    const spend = [
      ...(models.perRun === undefined ? [] : [`${money(models.perRun)} a run`]),
      ...(models.perDay === undefined ? [] : [`${money(models.perDay)} a day`]),
    ];
    if (spend.length > 0) { rows.push({ key: 'spend', label: 'Spend at most', values: spend }); }
  }
  if (grants.secrets !== undefined) { rows.push({ key: 'secrets', label: 'Secrets', values: grants.secrets }); }
  if (grants.calls !== undefined) { rows.push({ key: 'calls', label: 'May call', values: grants.calls }); }
  if (grants.network !== undefined) { rows.push({ key: 'network', label: 'Network hosts', values: grants.network }); }
  if (grants.files !== undefined) {
    rows.push({ key: 'read', label: 'Reads files in', values: grants.files.read }, { key: 'write', label: 'Writes files in', values: grants.files.write });
  }
  return rows;
}

/** Each refusal rule, in words. */
export const RULE_WORDS = {
  stage: 'Not live yet',
  effects: 'Undeclared change',
  mode: 'Beyond its mode',
  types: 'Undeclared type',
  capability: 'Hub call not granted',
  models: 'Model not granted',
  budget: 'Over budget',
  secrets: 'Secret not granted',
  calls: 'Fn not granted',
  network: 'Host not granted',
  files: 'Path not granted',
  visibility: 'Not visible',
} as const satisfies Record<RefusalRule, string>;

/** How each kind of change looks. */
export const CHANGE_LOOK = {
  added: { tone: 'ok', word: 'Added' },
  changed: { tone: 'accent', word: 'Changed' },
  removed: { tone: 'danger', word: 'Removed' },
} as const satisfies Record<ContractChange['change'], { tone: Tone; word: string }>;

/** Which side of a diff a piece is on: kept, added or removed. */
export type DiffKind = 'same' | 'add' | 'remove';

/** One piece of a diff: a line, a word or a block. */
export interface DiffPiece<T> {
  readonly kind: DiffKind;
  readonly value: T;
}

/** One line of a diff: kept, added or removed. */
export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
}

/** The most pieces a diff compares one by one; longer sides are shown removed then added. */
export const DIFF_LINES = 400;

/**
 * The diff of two sequences: a longest common subsequence of `a` and `b`, the rest marked removed or added (removals
 * first where both happen at one place). Sides longer than `limit` are shown all removed, then all added.
 */
export function sequenceDiff<T>(a: readonly T[], b: readonly T[], limit = DIFF_LINES): DiffPiece<T>[] {
  if (a.length > limit || b.length > limit) {
    return [...a.map((value): DiffPiece<T> => ({ kind: 'remove', value })), ...b.map((value): DiffPiece<T> => ({ kind: 'add', value }))];
  }
  // the longest common run of a[i..] and b[j..], row by row in one flat table
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  const run = (i: number, j: number): number => lengths[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j] ? run(i + 1, j + 1) + 1 : Math.max(run(i + 1, j), run(i, j + 1));
    }
  }
  const out: DiffPiece<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) { out.push({ kind: 'same', value: left }); i++; j++; }
    else if (left !== undefined && (right === undefined || run(i + 1, j) >= run(i, j + 1))) { out.push({ kind: 'remove', value: left }); i++; }
    else if (right !== undefined) { out.push({ kind: 'add', value: right }); j++; }
  }
  return out;
}

/** A JSON value as the lines a diff compares. */
function linesOf(value: Json | undefined): string[] {
  return value === undefined ? [] : JSON.stringify(value, null, 2).split('\n');
}

/** The line diff of a change's before and after (their pretty JSON lines). */
export function lineDiff(before: Json | undefined, after: Json | undefined): readonly DiffLine[] {
  return sequenceDiff(linesOf(before), linesOf(after)).map((piece) => ({ kind: piece.kind, text: piece.value }));
}

/** The most words a prose diff compares one by one. */
export const DIFF_WORDS = 1_500;

/** The word diff of two texts: words and the spaces between them, runs of one kind joined. */
export function wordDiff(before: string, after: string): readonly DiffLine[] {
  const words = (text: string): string[] => text.split(/(\s+)/).filter((word) => word !== '');
  const out: DiffLine[] = [];
  for (const piece of sequenceDiff(words(before), words(after), DIFF_WORDS)) {
    const last = out.at(-1);
    // a space between two changed words stays with them, so a replaced phrase reads as one
    if (last !== undefined && last.kind === piece.kind) { out[out.length - 1] = { kind: last.kind, text: last.text + piece.value }; }
    else { out.push({ kind: piece.kind, text: piece.value }); }
  }
  return out;
}

/** A markdown text's blocks: runs of lines split at blank lines, a fenced code block kept whole. */
export function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let block: string[] = [];
  let fenced = false;
  const close = (): void => { if (block.length > 0) { blocks.push(block.join('\n')); block = []; } };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; }
    if (!fenced && line.trim() === '') { close(); continue; }
    block.push(line);
  }
  close();
  return blocks;
}

/** One block of a markdown diff: kept, added, removed, or changed (with its word diff). */
export interface BlockDiff {
  readonly kind: DiffKind | 'change';
  /** The block's markdown (the new one, for a changed block). */
  readonly text: string;
  /** A changed block's words. */
  readonly words?: readonly DiffLine[];
}

/** The diff of two markdown texts block by block; a block removed right where one is added is one changed block. */
export function blockDiff(before: string, after: string): readonly BlockDiff[] {
  const pieces = sequenceDiff(markdownBlocks(before), markdownBlocks(after));
  const out: BlockDiff[] = [];
  for (let at = 0; at < pieces.length; at++) {
    const piece = pieces[at];
    if (piece === undefined) { continue; }
    // removed blocks followed by as many added ones pair up as changes
    if (piece.kind === 'remove') {
      let removed = at;
      while (pieces[removed]?.kind === 'remove') { removed++; }
      let added = removed;
      while (pieces[added]?.kind === 'add') { added++; }
      const pairs = Math.min(removed - at, added - removed);
      for (let k = 0; k < removed - at; k++) {
        const old = pieces[at + k]?.value ?? '';
        const next = k < pairs ? pieces[removed + k]?.value : undefined;
        out.push(next === undefined ? { kind: 'remove', text: old } : { kind: 'change', text: next, words: wordDiff(old, next) });
      }
      for (let k = pairs; k < added - removed; k++) { out.push({ kind: 'add', text: pieces[removed + k]?.value ?? '' }); }
      at = added - 1;
      continue;
    }
    out.push({ kind: piece.kind, text: piece.value });
  }
  return out;
}

/** Install checks in one line: "12 passed, 1 failed · 2 concerns". */
export function checksLine(checks: InstallChecks | undefined): string {
  if (checks === undefined) { return 'No checks recorded'; }
  const tests = checks.tests;
  const testPart = tests === undefined ? 'No tests' : [`${tests.passed} passed`, ...(tests.failed > 0 ? [`${tests.failed} failed`] : []), ...(tests.skipped > 0 ? [`${tests.skipped} skipped`] : [])].join(', ');
  const concerns = checks.scan.concerns.length;
  return `${testPart} · ${concerns === 0 ? 'no scan concerns' : `${concerns} scan ${concerns === 1 ? 'concern' : 'concerns'}`}`;
}

/** Whether the checks need the admin's eye: a failed test or a scan concern. */
export function checksWarn(checks: InstallChecks | undefined): boolean {
  return checks !== undefined && ((checks.tests?.failed ?? 0) > 0 || checks.scan.concerns.length > 0);
}

/**
 * What in the checks argues against going live, as one sentence ("1 test failed and the scan found 2 concerns"), or
 * undefined when nothing does.
 */
export function checksConcerns(checks: InstallChecks | undefined): string | undefined {
  if (checks === undefined || !checksWarn(checks)) { return undefined; }
  const failed = checks.tests?.failed ?? 0;
  const concerns = checks.scan.concerns.length;
  const parts = [
    ...(failed > 0 ? [`${failed} ${failed === 1 ? 'test' : 'tests'} failed`] : []),
    ...(concerns > 0 ? [`the scan found ${concerns} ${concerns === 1 ? 'concern' : 'concerns'}`] : []),
  ];
  const sentence = parts.join(' and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** Where the hub serves a file of a system's client build (`/clients/<system>/<hash>/<path>`, as the hub's `clientUrl`). */
export function clientFileUrl(system: SystemName, client: Pick<ClientAssets, 'hash' | 'entry'>): string {
  return `/clients/${encodeURIComponent(system)}/${client.hash}/${client.entry.split('/').map(encodeURIComponent).join('/')}`;
}

/** How long a fn takes, in one line: from its run history, else whether it usually runs long, else that it hasn't run. */
export function timeText(facts: Pick<FnFacts, 'times' | 'longRunning'>): string {
  const times = facts.times;
  if (times !== undefined && times.runs > 0) { return `About ${formatDuration(times.typical)}, slow ${formatDuration(times.slow)}`; }
  return facts.longRunning ? 'Usually runs long' : 'No runs yet';
}

/** A refusal in one plain sentence: what it tried, then why it was refused ("Tried OPENAI_API_KEY: it may read only NOTES_TOKEN."). */
export function refusalLine(refusal: Pick<RefusalRecord, 'attempt' | 'detail'>): string {
  const why = refusal.detail.trim().replace(/\.$/, '');
  return `Tried ${refusal.attempt}: ${why}.`;
}

// ─── The Pending tab ────────────────────────────────────────────────────────────

/** How a pending change is drawn: with its tab's own view, or only as a raw diff. */
export type ChangeView = 'fn' | 'type' | 'config-type' | 'context' | 'grants' | 'raw';

/** The sections drawn with their tab's own view; every other section shows a raw diff. */
const SECTION_VIEWS: Partial<Record<ContractChange['section'], ChangeView>> = { fns: 'fn', types: 'type', context: 'context', grants: 'grants' };

/** Which view draws a change: fns as a facts card, types and the config type as types, context as prose, grants as a delta. */
export function changeView(change: Pick<ContractChange, 'section' | 'name'>): ChangeView {
  // the config type is listed by the system's name; its other items (`notes connect`) have a word after it
  if (change.section === 'config') { return change.name.includes(' ') ? 'raw' : 'config-type'; }
  return SECTION_VIEWS[change.section] ?? 'raw';
}

/** A change's key within its review. */
export const changeKey = (change: Pick<ContractChange, 'section' | 'name'>): string => `${change.section}:${change.name}`;
/** The reference a decision names a change by. */
export const changeRef = (change: Pick<ContractChange, 'section' | 'name'>): ChangeRef => ({ section: change.section, name: change.name });

/** Each section's heading on the Pending tab. */
export const CHANGE_SECTION_WORDS = {
  fns: 'Fns', context: 'Context', types: 'Types', roots: 'Resource roots', grants: 'Grants', config: 'Config', ...PART_SECTION_WORDS,
} as const satisfies Record<ContractChange['section'], string>;

/** A section's heading, or the section's own name for one the page has no words for. */
export function sectionWords(section: string): string {
  const words: Readonly<Record<string, string>> = CHANGE_SECTION_WORDS;
  return words[section] ?? section;
}

/** A group of pending changes: one section of the contract's, or everything added while running. */
export interface ChangeGroup {
  readonly key: string;
  readonly label: string;
  readonly changes: readonly ContractChange[];
  /** Added while running: there can be many, so the tab shows them a page at a time. */
  readonly runtime: boolean;
}

/** The order sections are listed in: what the system may do first, then what it offers. */
const GROUP_ORDER: readonly ContractChange['section'][] = ['grants', 'config', ...ITEM_SECTIONS];

/** Pending changes grouped by section in the order above, then the ones added while running together. */
export function changeGroups(changes: readonly ContractChange[]): readonly ChangeGroup[] {
  const contract = changes.filter((change) => change.origin === 'contract');
  const runtime = changes.filter((change) => change.origin === 'runtime');
  const groups: ChangeGroup[] = GROUP_ORDER.flatMap((section) => {
    const of = contract.filter((change) => change.section === section);
    return of.length === 0 ? [] : [{ key: section, label: CHANGE_SECTION_WORDS[section], changes: of, runtime: false }];
  });
  if (runtime.length > 0) { groups.push({ key: 'runtime', label: 'Added while running', changes: runtime, runtime: true }); }
  return groups;
}

/** How many runtime changes the tab shows at first, and how many more each "Show more" adds. */
export const RUNTIME_PAGE = 20;

/** One fact of a fn before and after a change. */
export interface FactRow {
  readonly key: 'mode' | 'effects' | 'reads' | 'writes' | 'deps' | 'cost';
  readonly label: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly changed: boolean;
}

/** Each fn mode in words. */
export const MODE_WORDS = { read: 'Reads only', write: 'Writes', delete: 'Deletes' } as const satisfies Record<FnMode, string>;

/** Each fact's label, in the order the card lists them. */
/** The fact rows, in order. */
const FACT_KEYS: readonly FactRow['key'][] = ['mode', 'effects', 'reads', 'writes', 'deps', 'cost'];
const FACT_LABELS = { mode: 'Mode', effects: 'Changes in the hub', reads: 'Types read', writes: 'Types written', deps: 'Uses', cost: 'Cost' } as const satisfies Record<FactRow['key'], string>;

/** A changed fn's facts as rows, before and after; a side the fn doesn't exist on is absent. */
export function factRows(facts: FnChangeFacts, money: (usd: number) => string): readonly FactRow[] {
  const list = (names: readonly string[] | undefined): string | undefined => (names === undefined ? undefined : names.length === 0 ? 'None' : names.join(', '));
  const cost = (side: DeclaredFnFacts | undefined): string | undefined => (side === undefined ? undefined : side.free === true ? 'Free' : side.cost === undefined ? 'Not estimated' : `About ${money(side.cost)} a run`);
  const of = (side: DeclaredFnFacts | undefined): Record<FactRow['key'], string | undefined> => ({
    mode: side === undefined ? undefined : MODE_WORDS[side.mode],
    effects: side === undefined ? undefined : side.effects ?? 'None',
    reads: list(side?.reads), writes: list(side?.writes), deps: list(side?.deps), cost: cost(side),
  });
  const before = of(facts.before);
  const after = of(facts.after);
  return FACT_KEYS.map((key) => ({
    key, label: FACT_LABELS[key], before: before[key], after: after[key], changed: facts.before !== undefined && facts.after !== undefined && before[key] !== after[key],
  }));
}

/** A field of a declaration, when it is a string (`description`, a context item's `content`). */
export function textOf(value: Json | undefined, field: 'description' | 'content'): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return undefined; }
  const text = value[field];
  return typeof text === 'string' ? text : undefined;
}

/** A type change as the type-diff part its view draws: a named type's `def`, or the config type itself. */
export function typeDiffPart(change: ContractChange): Extract<PreviewPart, { type: 'type-diff' }> {
  const defOf = (value: Json | undefined): GinTypeDef | undefined => {
    const def = change.section === 'types' && typeof value === 'object' && value !== null && !Array.isArray(value) ? value['def'] : value;
    const parsed = GinTypeDef.safeParse(def);
    return parsed.success ? parsed.data : undefined;
  };
  const before = defOf(change.before);
  const after = defOf(change.after);
  return { type: 'type-diff', name: change.section === 'config' ? `${change.name} config` : change.name, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), changes: [], breaks: [] };
}

/** Grants as the delta view reads them, from a change's side. */
export function grantsOf(value: Json | undefined): SystemGrants | undefined {
  const parsed = SystemGrants.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** One value of a grant row in a delta: kept, newly granted, or no longer granted. */
export interface GrantValue {
  readonly value: string;
  readonly kind: DiffKind;
}

/** A grant row with each value marked against the grants before. */
export interface GrantDeltaRow extends Omit<GrantRow, 'values'> {
  readonly values: readonly GrantValue[];
}

/** Grants as rows with each value marked against `before` (all kept when there is no before): granted now, kept, or gone. */
export function grantDeltaRows(before: SystemGrants | undefined, after: SystemGrants | undefined, money: (usd: number) => string): readonly GrantDeltaRow[] {
  const was = new Map(before === undefined ? [] : grantRows(before, money).map((row) => [row.key, row]));
  const now = grantRows(after ?? { hub: [] }, money);
  const rows: GrantDeltaRow[] = now.map((row) => {
    const old = was.get(row.key)?.values ?? [];
    const values = row.values.map((value): GrantValue => ({ value, kind: before === undefined || old.includes(value) ? 'same' : 'add' }));
    const gone = old.filter((value) => !row.values.includes(value)).map((value): GrantValue => ({ value, kind: 'remove' }));
    return { key: row.key, label: row.label, values: [...values, ...gone] };
  });
  // rows granted before and not at all now
  for (const [key, row] of was) {
    if (!now.some((other) => other.key === key) && row.values.length > 0) { rows.push({ key, label: row.label, values: row.values.map((value): GrantValue => ({ value, kind: 'remove' })) }); }
  }
  return rows;
}

/** How each risk flag looks on the strip. */
export const FLAG_LOOK = {
  'delete-fns': { tone: 'danger', icon: 'trash' },
  'write-fns': { tone: 'warn', icon: 'edit' },
  injects: { tone: 'warn', icon: 'chat' },
  effects: { tone: 'warn', icon: 'layers' },
  capabilities: { tone: 'warn', icon: 'shield' },
  secrets: { tone: 'danger', icon: 'key' },
  hosts: { tone: 'warn', icon: 'globe' },
  files: { tone: 'warn', icon: 'folder' },
  calls: { tone: 'accent', icon: 'fn' },
  models: { tone: 'accent', icon: 'cpu' },
} as const satisfies Record<ReviewFlagKind, { tone: Tone; icon: IconName }>;

/** The flags whose items are fns (or fn globs, for `calls`), each drawn as a pill. */
const FN_FLAGS: ReadonlySet<ReviewFlagKind> = new Set(['delete-fns', 'write-fns', 'effects', 'calls']);

/** A flag about fns as the strip draws it: the words before them, the fns as pills, and the words after (the effects). */
export interface FlagFns {
  readonly lead: string;
  readonly fns: readonly string[];
  readonly tail: string;
}

/**
 * A flag about fns as its parts, so each fn is a pill between the hub's own words (`ReviewFlag.lead` and `tail`, the
 * parts its line is written from). Undefined for a flag about something else, or one kept from before it had parts
 * (it is then drawn as its line).
 */
export function flagFns(flag: ReviewFlag): FlagFns | undefined {
  if (!FN_FLAGS.has(flag.flag) || flag.items.length === 0 || flag.lead === undefined) { return undefined; }
  return { lead: flag.lead, fns: flag.items, tail: flag.tail ?? '' };
}

/** What happened to the grants, for the strip's chip. */
export const GRANTS_MOVE_LOOK = {
  widened: { tone: 'warn', word: 'Grants widened' },
  narrowed: { tone: 'ok', word: 'Grants narrowed' },
  changed: { tone: 'warn', word: 'Grants changed' },
  added: { tone: 'accent', word: 'Grants declared' },
} as const satisfies Record<GrantsMove, { tone: Tone; word: string }>;
