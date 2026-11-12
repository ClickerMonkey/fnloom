/**
 * How a system's review reads (build 7): its stage, the items an admin switched off, each fn joined with the facts the
 * hub worked out, its grants as plain rows, its pending changes as line diffs, its refusals in words, and its checks'
 * counts. Pure, so it is tested alone.
 */
import {
  effectsLine, qualify, type ClientAssets, type ContractChange, type FnDecl, type FnFacts, type HubCapability, type InstallChecks, type ItemRef, type ItemSection,
  type Json, type QualifiedName, type RefusalRecord, type RefusalRule, type SystemGrants, type SystemName, type SystemReview, type SystemStage,
} from '@harness/core';
import { formatDuration } from '../../chat/logic/format.ts';
import type { Tone } from '../../ui/index.ts';
import type { StatusLook } from './systems.ts';

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

/** One line of a diff: kept, added or removed. */
export interface DiffLine {
  readonly kind: 'same' | 'add' | 'remove';
  readonly text: string;
}

/** The most lines a diff compares line by line; longer sides are shown removed then added. */
export const DIFF_LINES = 400;

/** A JSON value as the lines a diff compares. */
function linesOf(value: Json | undefined): string[] {
  return value === undefined ? [] : JSON.stringify(value, null, 2).split('\n');
}

/** The line diff of a change's before and after (a longest common subsequence of their pretty JSON lines). */
export function lineDiff(before: Json | undefined, after: Json | undefined): readonly DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > DIFF_LINES || b.length > DIFF_LINES) {
    return [...a.map((text): DiffLine => ({ kind: 'remove', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))];
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
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) { out.push({ kind: 'same', text: left }); i++; j++; }
    else if (left !== undefined && (right === undefined || run(i + 1, j) >= run(i, j + 1))) { out.push({ kind: 'remove', text: left }); i++; }
    else if (right !== undefined) { out.push({ kind: 'add', text: right }); j++; }
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
