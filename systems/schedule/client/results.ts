/**
 * What the schedule system's result renderers draw (docs/plans/schedule-system.md, "Result renderer" and "The run
 * page"), as plain functions so they are tested alone:
 *
 * - **A schedule** (`schedule/add`, `change` and each of `list`'s items, a `ScheduleView`): its name in words, what it
 *   runs, when in words, its next runs, whether it is paused, when it notifies, how its last run went, the next run's
 *   args, and a link to its page.
 * - **A firing's run** (a run of a `schedule/schedule` fn, drawn by the kind's result renderer above the target's own
 *   result): the schedule's name, when the run was planned for (or that it was run by hand), and a link to its history.
 *
 * Links are the app's paths to the schedule's page (`/s/schedule/item/<schedule>`), from the contract's page refs.
 */
import { fnLabel, QualifiedName, systemPagePath, Timestamp, type Json } from '@harness/core';
import type { PartTone } from '@harness/sdk';
import { z } from 'zod';
import { schedule, ScheduleView } from '../shared/index.ts';
import { instantWords, localOf, NOTIFY_WORDS, STATUS_LOOK, todayIn } from './logic.ts';

/** A link to a schedule's page, with its query (`tab=history`, `firing=<key>`). */
export function scheduleHref(name: string, query: Readonly<Record<string, string>> = {}): string {
  const path = systemPagePath(schedule.name, schedule.page.item.segment, [localOf(name)]);
  const search = new URLSearchParams(query).toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The calendar's path. */
export function calendarHref(): string {
  return systemPagePath(schedule.name, schedule.page.calendar.segment);
}

/** One schedule as a card draws it. */
export interface ScheduleCard {
  readonly name: QualifiedName;
  /** Its name in words: "Weekly orders summary". */
  readonly title: string;
  /** The fn it runs. */
  readonly fn: QualifiedName;
  /** When it runs, in words. */
  readonly says: string;
  /** Its next runs, in its zone's words. */
  readonly next: readonly string[];
  /** "Paused", "Paused until Mon, Jan 4", or absent. */
  readonly paused?: string;
  /** When it notifies, in words. */
  readonly notifies: string;
  /** How its last run went, when it ran before. */
  readonly last?: { readonly word: string; readonly tone: PartTone; readonly summary?: string };
  /** The next run's args, as JSON text. */
  readonly firstArgs?: string;
  readonly href: string;
  readonly historyHref: string;
}

/** A schedule's view as a card: absent when the result isn't one (an old or broken result). */
export function scheduleCard(result: unknown): ScheduleCard | undefined {
  const parsed = ScheduleView.safeParse(result);
  if (!parsed.success) { return undefined; }
  const view = parsed.data;
  const paused = view.paused === undefined ? undefined : view.paused.until === undefined ? 'Paused until resumed' : `Paused until ${view.paused.until}`;
  const look = view.last === undefined ? undefined : STATUS_LOOK[view.last.status];
  return {
    name: view.schedule, title: fnLabel(view.schedule), fn: view.fn, says: view.says,
    next: view.next.map((run) => run.local),
    ...(paused === undefined ? {} : { paused }),
    notifies: NOTIFY_WORDS[view.notify],
    ...(look === undefined || view.last === undefined ? {} : { last: { word: look.word, tone: look.tone, ...(view.last.summary === undefined ? {} : { summary: view.last.summary }) } }),
    ...(view.firstArgs === undefined ? {} : { firstArgs: argsText(view.firstArgs) }),
    href: scheduleHref(view.schedule),
    historyHref: scheduleHref(view.schedule, { tab: 'history' }),
  };
}

/** `schedule/list`'s result as cards (the items that read). */
export function listCards(result: unknown): ScheduleCard[] {
  const parsed = z.object({ items: z.array(z.unknown()) }).safeParse(result);
  if (!parsed.success) { return []; }
  return parsed.data.items.flatMap((item) => scheduleCard(item) ?? []);
}

/** Args as one line of JSON, for a card. */
export function argsText(args: Json): string {
  return JSON.stringify(args);
}

/** The header the kind's result renderer draws above a firing's result. */
export interface FiringHeader {
  /** The schedule's name in words. */
  readonly title: string;
  /** "Planned for Mon, Nov 30, 9:00 am", or "Run by hand". */
  readonly when: string;
  readonly href: string;
  readonly historyHref: string;
}

/** The schedule fn's own args: `at` when the timer planned it. */
const FiringArgs = z.object({ at: Timestamp.optional() }).loose();

/** A firing's header, read in the viewer's zone. */
export function firingHeader(fn: string, args: unknown, zone: string, now = Date.now()): FiringHeader {
  const parsed = FiringArgs.safeParse(args);
  const at = parsed.success ? parsed.data.at : undefined;
  return {
    title: labelOf(fn),
    when: at === undefined ? 'Run by hand, outside its times' : `Planned for ${instantWords(at, zone, todayIn(zone, now))}`,
    href: scheduleHref(fn),
    historyHref: scheduleHref(fn, { tab: 'history' }),
  };
}

/** A fn's name in words, or the name itself when it isn't a qualified one. */
function labelOf(fn: string): string {
  const name = QualifiedName.safeParse(fn);
  return name.success ? fnLabel(name.data) : fn;
}
