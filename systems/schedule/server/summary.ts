/**
 * What the owner of a schedule is told about a firing, worked out by fixed rules and never by a model
 * (docs/plans/schedule-system.md, "What the owner is told"): the one-line summary kept on the firing record and sent
 * as the notice's body, which firings are told at all, and each notice's title and tone.
 *
 * The summary, at most `NOTIFICATION_BODY` characters:
 * 1. a firing that failed, was cancelled, refused, expired, missed or skipped: its error or reason;
 * 2. one that ran with text (an agent's answer): its first paragraph, markdown removed;
 * 3. with a table or a list: "12 rows" or "3 items", then the first row's most telling value;
 * 4. with an object: its most telling text field (`summary`, `message`, `title`, `text`, `name`, …);
 * 5. otherwise: the target's own done status line ("Found 12 orders"), or "Ran <fn>".
 * A firing that started late ends with "(2 h late)".
 */
import { argSummary, clamp, fnLabel, lowerFirst, NOTIFICATION_BODY, type Json, type QualifiedName } from '@harness/core';
import type { FiringStatus, Notify } from '../shared/types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The fields an object's summary is read from, most telling first. */
const TELLING_FIELDS = ['summary', 'message', 'title', 'text', 'name', 'description', 'label'] as const;

/** What a firing's summary is worked out from. */
export interface SummaryInput {
  readonly status: FiringStatus;
  /** The target fn, for the fallback "Ran <fn>". */
  readonly target: QualifiedName;
  /** The target's result, when it ran. */
  readonly result?: Json | undefined;
  /** Why it didn't run cleanly: the run's error message or the firing's reason. */
  readonly reason?: string | undefined;
  /** The target run's own done status line, as the hub worded it ("Found 12 orders"). */
  readonly doneText?: string | undefined;
  /** How late it started, in ms. */
  readonly late?: number | undefined;
  /** At most this late counts as on time (`SCHEDULE_ON_TIME`). */
  readonly onTime?: number | undefined;
}

/** A span of time in a few words: "5 min", "2 h", "3 d". */
export function spanWords(ms: number): string {
  if (ms < HOUR) { return `${String(Math.max(1, Math.round(ms / MINUTE)))} min`; }
  if (ms < DAY) { return `${String(Math.round(ms / HOUR))} h`; }
  return `${String(Math.round(ms / DAY))} d`;
}

/** Markdown taken out of one paragraph: headings, emphasis, code marks, links (their text kept), quotes and bullets. */
export function plainParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part !== '' && !/^```/.test(part));
  const first = paragraphs[0] ?? '';
  return first
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|`|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value said in a few words: text as it is, a number or yes/no, an object by its telling field. */
function said(value: Json | undefined): string {
  if (value === undefined || value === null) { return ''; }
  if (typeof value === 'string') { return plainParagraph(value); }
  if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
  if (Array.isArray(value)) { return ''; }
  return tellingText(value);
}

/** An object's most telling text: the first of `TELLING_FIELDS` with text, else what core's `argSummary` picks. */
export function tellingText(value: { [key: string]: Json }): string {
  for (const field of TELLING_FIELDS) {
    const text = value[field];
    if (typeof text === 'string' && text.trim() !== '') { return plainParagraph(text); }
  }
  return argSummary(value, NOTIFICATION_BODY);
}

/** A result table (`{ columns, rows }`): its row count and its first row in words. */
function tableWords(value: { [key: string]: Json }): string | undefined {
  const rows = value['rows'];
  if (!Array.isArray(rows) || !Array.isArray(value['columns'])) { return undefined; }
  const count = `${String(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`;
  const first = rows[0];
  const cells = Array.isArray(first) ? first.map(said).filter((cell) => cell !== '').slice(0, 2).join(' ') : said(first);
  return cells === '' ? count : `${count}: ${cells}${rows.length > 1 ? ', …' : ''}`;
}

/** A list: its item count and its first item in words. */
function listWords(items: readonly Json[]): string {
  const count = `${String(items.length)} ${items.length === 1 ? 'item' : 'items'}`;
  const first = said(items[0]);
  return first === '' ? count : `${count}: ${first}${items.length > 1 ? ', …' : ''}`;
}

/** The line for a firing that ran, before any "late" suffix (rules 2 to 5). */
function ranLine(input: SummaryInput): string {
  const { result } = input;
  if (typeof result === 'string' && plainParagraph(result) !== '') { return plainParagraph(result); }
  if (Array.isArray(result)) { return listWords(result); }
  if (isRecord(result)) {
    const table = tableWords(result);
    if (table !== undefined) { return table; }
    for (const field of TELLING_FIELDS) {
      const text = result[field];
      if (typeof text === 'string' && text.trim() !== '') { return plainParagraph(text); }
    }
  }
  if (input.doneText !== undefined && input.doneText.trim() !== '') { return input.doneText.trim(); }
  return `Ran ${lowerFirst(fnLabel(input.target))}`;
}

/** The one line a firing is summed up in, at most `NOTIFICATION_BODY` characters (the rules above). */
export function summaryLine(input: SummaryInput): string {
  const base = input.status === 'ran' || input.status === 'running' || input.status === 'waiting'
    ? ranLine(input)
    : input.reason ?? `It ${statusWords(input.status)}.`;
  const late = input.late ?? 0;
  const suffix = input.status !== 'missed' && input.status !== 'skipped' && late > (input.onTime ?? MINUTE) ? ` (${spanWords(late)} late)` : '';
  return `${clamp(base, NOTIFICATION_BODY - suffix.length)}${suffix}`;
}

/** A status as the end of a sentence about a firing ("… was refused"). */
export function statusWords(status: FiringStatus): string {
  switch (status) {
    case 'running': return 'is running';
    case 'waiting': return 'is waiting for approval';
    case 'ran': return 'ran';
    case 'failed': return 'failed';
    case 'cancelled': return 'was cancelled';
    case 'skipped': return 'was skipped';
    case 'missed': return 'was missed';
    case 'refused': return 'was refused';
    case 'expired': return 'gave up waiting for approval';
  }
}

/** What decides whether a settled firing is told. */
export interface TellInput {
  readonly notify: Notify;
  readonly status: FiringStatus;
  readonly manual: boolean;
  /** The firing's run (or one under it) already told its person something (`schedule/remind`). */
  readonly notifiedByRun?: boolean | undefined;
  /** It was cancelled by its person (or the run above it), not by the schedule's rules or a decline. */
  readonly byPerson?: boolean | undefined;
  /** A refusal: the reason last told for this schedule, so one reason is told once until a firing runs again. */
  readonly refusedBefore?: string | undefined;
  /** This firing's reason. */
  readonly reason?: string | undefined;
}

/**
 * Whether the owner is told about a settled firing: never a manual one ("run now": they started it), a skipped one, or
 * any with `notify: 'never'`; with `'failed'` all but those that ran; a firing that ran is not told when its run
 * already told its person something; a refusal only when its reason differs from the last one told; a cancel only
 * when the person didn't cancel it themselves.
 */
export function tells(input: TellInput): boolean {
  if (input.manual || input.notify === 'never') { return false; }
  switch (input.status) {
    case 'running': case 'waiting': case 'skipped': return false;
    case 'ran': return input.notify === 'always' && input.notifiedByRun !== true;
    case 'cancelled': return input.byPerson !== true;
    case 'refused': return input.reason === undefined || input.reason !== input.refusedBefore;
    case 'failed': case 'missed': case 'expired': return true;
  }
}

/** A notice's title: the schedule's title and the outcome ("Weekly summary ran", "… missed 3 times"). */
export function titleOf(title: string, status: FiringStatus, missed = 1): string {
  if (status === 'missed') { return `${title} missed ${missed === 1 ? 'a run' : `${String(missed)} runs`}`; }
  return `${title} ${statusWords(status)}`;
}

/** A notice's tone: ok for a firing that ran, info for missed ones, failed for the rest. */
export function toneOf(status: FiringStatus): 'ok' | 'failed' | 'info' {
  if (status === 'ran') { return 'ok'; }
  return status === 'missed' ? 'info' : 'failed';
}
