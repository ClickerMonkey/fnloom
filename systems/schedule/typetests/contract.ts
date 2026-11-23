// Compile-time proof for the schedule system's contract (slice 1, docs/plans/schedule-system.md "What doesn't
// compile"): its shapes have one source (zod, made gin with `ginAs`), firings and days are branded so a hand-written
// string doesn't fit where a parsed one goes, its payload has no `deliver` or `chat`, and its refs are typed. The
// hub-side refusals (`runs.start`, `runs.notify`, `kindFns`, `ctx.notify`, page refs, `replaces`) come with slice 3
// and 4. Nothing here runs: `npm run typecheck` fails if an expectation breaks, and every `@ts-expect-error` marks a
// mistake that must not compile.

import { expectType, type ContextRef, type Equal, type Infer, type KindRef } from '@harness/sdk';
import type { z } from 'zod';
import { OccurrenceKey } from '../shared/index.ts';
import type { AddArgs, ChangeArgs, FiringShape, FiringStatus, LocalDay, SchedulePayload, ScheduleView, View, When, schedule } from '../shared/index.ts';

// ── One source: the gin types are the zod shapes' input ──────────────────────

expectType<Equal<typeof schedule.kinds.schedule, KindRef<'schedule/schedule', z.input<typeof SchedulePayload>>>>(true);
expectType<Equal<Infer<typeof View>, z.input<typeof ScheduleView>>>(true);
expectType<Equal<Infer<typeof schedule.types.Firing>, z.input<typeof FiringShape>>>(true);
expectType<Equal<typeof schedule.context.basics, ContextRef<'schedule/basics', {}>>>(true);
expectType<Equal<typeof schedule.fns.add.name, 'schedule/add'>>(true);

// a payload's defaults are optional going in and filled coming out
expectType<Equal<z.input<typeof SchedulePayload>['notify'], 'always' | 'failed' | 'never' | undefined>>(true);
expectType<Equal<z.infer<typeof SchedulePayload>['notify'], 'always' | 'failed' | 'never'>>(true);

// ── Branded strings: a firing key, a day, come from a parse, never a literal ─

declare const parsed: When;
const key: OccurrenceKey = OccurrenceKey.parse('2026-12-24T18:00');
const skipped: When = { ...parsed, exclude: [key] };
void skipped;
// @ts-expect-error an exclude is an OccurrenceKey (from When.parse or the shared helpers), not a hand-written string
const typed: When = { exclude: ['2026-12-24 18:00'] };
void typed;
// @ts-expect-error a day is a LocalDay, not any string
const day: LocalDay = '2026-12-25';
void day;

// ── No delivery to a chat: the payload has no `deliver` or `chat` ────────────

const payload = {
  fn: 'schedule/remind', when: {}, zone: 'UTC', args: { kind: 'new', type: { name: 'obj' }, value: {} },
} satisfies z.input<typeof SchedulePayload>;
void payload;
// @ts-expect-error results come as a notification; there is no deliver field
const delivered: z.input<typeof SchedulePayload> = { ...payload, deliver: 'chat' };
void delivered;
// @ts-expect-error nor a chat option
const chatted: z.input<typeof SchedulePayload> = { ...payload, chat: 'session' };
void chatted;

// a firing's day and time are its key, not fields of their own
expectType<Equal<'day' | 'time' extends keyof z.infer<typeof FiringShape> ? true : false, false>>(true);
expectType<Equal<z.infer<typeof FiringShape>['status'], FiringStatus>>(true);

// ── The chat's args: a fn is a qualified name, change takes any of add's fields ─

type Add = Infer<typeof AddArgs>;
type Change = Infer<typeof ChangeArgs>;
const add: Add = { fn: 'database/main.orders_by_week', when: { dayOfWeek: [1], times: ['09:00'] } };
void add;
// @ts-expect-error a fn is named `system/name`
const unnamed: Add = { fn: 'orders_by_week', when: {} };
void unnamed;
// @ts-expect-error add needs `when`
const whenless: Add = { fn: 'database/main.orders_by_week' };
void whenless;
const change: Change = { schedule: 'schedule/weekly_orders_summary', notify: 'failed' };
void change;
// @ts-expect-error notify is always, failed or never
const loud: Change = { schedule: 'schedule/weekly_orders_summary', notify: 'sometimes' };
void loud;
