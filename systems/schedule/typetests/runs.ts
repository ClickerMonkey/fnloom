// Compile-time proof for the hub's generic additions as the schedule system meets them (slice 3,
// docs/plans/schedule-system.md "What doesn't compile"): `ctx.runs` takes only this system's own kinds and the fns
// `kindFns` listed (never another system's, never a hand-built object), `runs.start` needs a `key`, `runs.notify` has no
// `to`, `ctx.notify` exists only in a run, and a notice links to this system's own pages by ref, never by segment
// string. Nothing here runs: `npm run typecheck` fails if an expectation breaks, and every `@ts-expect-error` marks a
// mistake that must not compile.

import { expectType, g, kind, system, type Equal, type KindFn, type OwnOf, type PageRef, type SystemCtx, type SystemImpl } from '@harness/sdk';
import type { SchedulePayload } from '../shared/index.ts';
import { schedule, type ScheduleConfigInput, type ScheduleContract } from '../shared/index.ts';
import type { z } from 'zod';

type Own = OwnOf<ScheduleContract['defs']>;
type Ctx = SystemCtx<ScheduleConfigInput, Own>;
type Impl = SystemImpl<ScheduleContract['defs']>;
/** The run ctx `schedule/remind` gets. */
type RunCtx = Parameters<Impl['fns']['remind']['run']>[1];

// ── Page refs: one per declared page, named <system>/<segment> ──────────────

expectType<Equal<typeof schedule.page.item, PageRef<'schedule/item'>>>(true);
expectType<Equal<keyof typeof schedule.page, 'calendar' | 'item' | 'all'>>(true);
// @ts-expect-error a page that isn't declared has no ref
void schedule.page.month;

// ── What a ctx of this system calls its own ─────────────────────────────────

expectType<Equal<Own['kinds'], typeof schedule.kinds.schedule>>(true);
expectType<Equal<Own['pages'], PageRef<'schedule/calendar'> | PageRef<'schedule/item'> | PageRef<'schedule/all'>>>(true);

declare const ctx: Ctx;
declare const run: RunCtx;

/** Another system, with a kind and a page of its own. */
const other = system('other', { description: 'Another system.', pages: [{ segment: 'board', title: 'Board', component: 'Board' }] })
  .with({ kinds: { note: kind({ description: 'A note.', applicability: 'Notes.', payload: g.obj({ text: g.text() }) }) } });

declare const foreign: KindFn<typeof other.kinds.note>;

export async function proofs(): Promise<void> {
  const { items } = await ctx.runs.kindFns(schedule.kinds.schedule, { changedSince: 0 });
  const due = items[0];
  if (due === undefined) { return; }
  // a listed fn carries its kind's payload type
  expectType<Equal<typeof due.payload, z.input<typeof SchedulePayload>>>(true);
  expectType<Equal<typeof due.version, number>>(true);
  const started = await ctx.runs.start(due, { args: { at: 0 }, key: `schedule:${due.fn}@0`, priority: 'background' });
  await ctx.runs.notify(due, {
    title: 'Weekly sales summary ran', body: '12 rows', tone: 'ok', key: `schedule:${due.fn}`,
    link: { run: started.run },
    also: { label: 'History', link: { page: schedule.page.item, path: ['weekly_sales_summary'], query: { tab: 'history' } } },
  });

  // @ts-expect-error another system's kind is not this system's to list
  await ctx.runs.kindFns(other.kinds.note);
  // @ts-expect-error a start needs a key: the same key is the same run
  await ctx.runs.start(due, { args: {} });
  // @ts-expect-error a fn not listed by kindFns (built by hand) can't be started
  await ctx.runs.start({ fn: 'schedule/x', kind: 'schedule/schedule', owner: 'act_1', title: 'X', version: 1, payload: due.payload, removed: false, updatedAt: 0 }, { args: {}, key: 'k' });
  // @ts-expect-error another system's kind fn can't be started
  await ctx.runs.start(foreign, { args: {}, key: 'k' });
  // @ts-expect-error nor notified about
  await ctx.runs.notify(foreign, { title: 't', body: 'b' });
  // @ts-expect-error a notice goes to the fn's owner only: there is no `to`
  await ctx.runs.notify(due, { title: 't', body: 'b', to: 'act_2' });
  // @ts-expect-error a notice links to a page by ref, never by segment string
  await ctx.runs.notify(due, { title: 't', body: 'b', link: { page: 'item' } });
  // @ts-expect-error nor to another system's page
  await ctx.runs.notify(due, { title: 't', body: 'b', link: { page: other.page.board } });

  // in a run: the run's own person, with this system's pages
  await run.notify({ title: 'Reminder', body: 'Take the bins out.', link: { page: schedule.page.calendar } });
  // @ts-expect-error a run's ctx has no runs: the system starts runs from outside any run
  void run.runs;
}

// @ts-expect-error a system's ctx has no notify: outside a run there is no person to tell (use runs.notify)
export const notifyOutsideRun = (c: Ctx): unknown => c.notify;

// the implementation's ctxs are typed with the system's own refs
expectType<Equal<Parameters<NonNullable<NonNullable<Impl['lifecycle']>['started']>>[0], Ctx>>(true);
