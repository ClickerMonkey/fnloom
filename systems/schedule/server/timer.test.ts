/**
 * The schedule timer with a fake clock and the SDK's fake hub: each schedule's next firing queued at its instant in
 * its zone (daylight saving included), started as its owner with the firing's key, its args worked out from `fire`,
 * recorded as a `schedule/Firing` with its summary and told by the rules; missed firings within and outside the grace
 * window; overlap skip; a doubled start; waits for approval that expire, and the admin's "refuse"; the limits.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorId, QualifiedName, RunId, TurnId, type DataRecord, type Json, type KindFnWire, type RunSettled } from '@harness/core';
import { reject } from '@ayepi/core';
import { TEST_USER, testHub, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FiringShape, SchedulePayload, schedule, type ScheduleConfigInput } from '../shared/index.ts';
import { scheduleEnv } from './env.ts';
import { createScheduleImpl } from './impl.ts';
import { Timer, type Clock, type ScheduleCtx } from './timer.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A clock the test moves. */
class FakeClock implements Clock {
  t: number;
  constructor(t: number) { this.t = t; }
  now(): number { return this.t; }
  set(t: number): void { this.t = t; }
}

const TARGET = QualifiedName.parse('demo/orders_report');
const TARGET_ARGS = { name: 'obj', props: { day: { type: { name: 'text' } } } };
const TARGET_RETURNS = { name: 'obj', props: { summary: { type: { name: 'text' } }, total: { type: { name: 'num' } } } };
/** `{ day: fire.day }`: the target's args from the firing's local day. */
const DAY_ARGS = { kind: 'new', type: TARGET_ARGS, value: { day: { kind: 'get', path: [{ prop: 'fire' }, { prop: 'day' }] } } };

/** A schedule's payload as the hub keeps it (JSON). */
function payload(when: Json, extra: Record<string, Json> = {}): Json {
  return { fn: TARGET, when, zone: 'America/New_York', args: DAY_ARGS, ...extra };
}

/** A payload read by the zod shapes, as the kind is handed it. */
const typed = (body: Json): SchedulePayload => SchedulePayload.parse(body);

/** What the target is called with. */
const DayArgs = z.object({ day: z.string() });

/** A schedule fn as `kindFns` lists it. */
function listed(local: string, body: Json, updatedAt: number, version = 1): KindFnWire {
  return { fn: QualifiedName.parse(`schedule/${local}`), kind: QualifiedName.parse('schedule/schedule'), owner: TEST_USER.id, title: 'Orders report', version, payload: body, removed: false, updatedAt };
}

type Kit = TestSystem<'schedule', (typeof schedule)['defs']>;

interface Served {
  readonly kit: Kit;
  readonly clock: FakeClock;
  readonly timer: Timer;
  /** Pending target calls the test settles by hand (when `hold` is set). */
  readonly held: Array<{ call: { parent: string; key: string }; settle: (settled: RunSettled) => void }>;
  /** Run a started firing on the system as the hub would: its kind run, then the settled `run` event. */
  runStarted(index: number, options?: { notified?: boolean; settle?: boolean }): Promise<void>;
  firings(): Array<{ owner: DataRecord['owner']; value: FiringShape }>;
  /** The timer started again on the same data folder (after `timer.stop()`: the system was down). */
  restart(): Promise<void>;
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) { await step(); }
  cleanup = [];
});

/** The system served with a fake clock at `start`, its schedules listed and adopted (an `fns` event). */
async function served(start: number, schedules: Record<string, Json>, options: { config?: ScheduleConfigInput; hold?: boolean; result?: Json } = {}): Promise<Served> {
  const clock = new FakeClock(start);
  const dir = mkdtempSync(join(tmpdir(), 'schedule-timer-'));
  const settings = { ...scheduleEnv.parse(), SCHEDULE_DB: join(dir, 'timer.db'), SCHEDULE_POLL: 10, SCHEDULE_RETRY: 50 };
  const timer = new Timer({ settings, clock });
  const impl = createScheduleImpl({ settings, timer });
  let ctx: ScheduleCtx | undefined;
  const kit = await testHub(schedule, { ...impl, lifecycle: { ...impl.lifecycle, started: async (c) => { ctx = c; await timer.start(c); } } }, { config: options.config ?? {} });
  cleanup.push(async () => { await kit.stop(); await timer.stop(); rmSync(dir, { recursive: true, force: true }); });
  const held: Served['held'] = [];
  kit.hub.onCall = (call) => {
    if (call.fn === 'hub/fns_get') {
      return Promise.resolve({ status: 'done', result: { fn: TARGET, kind: 'native', description: 'Orders of a day.', version: 1, available: true, args: TARGET_ARGS, returns: TARGET_RETURNS } });
    }
    if (options.hold === true) {
      return new Promise<RunSettled>((resolve) => { held.push({ call, settle: resolve }); });
    }
    return Promise.resolve({ status: 'done', result: options.result ?? { summary: `12 orders on ${DayArgs.parse(call.args).day}`, total: 1240 } });
  };
  kit.hub.kindFns = Object.entries(schedules).map(([local, body]) => listed(local, body, start));
  await kit.hub.peer().call('event', { type: 'fns', added: kit.hub.kindFns.map((fn) => fn.fn), removed: [], changed: [] });
  const runStarted: Served['runStarted'] = async (index, runOptions = {}) => {
    const start = kit.hub.starts[index];
    if (start === undefined) { throw new Error(`no start ${String(index)}`); }
    const run = kit.hub.startedRuns.get(start.key)?.run;
    if (run === undefined) { throw new Error('no run'); }
    const fn = kit.hub.kindFns.find((item) => item.fn === start.fn);
    if (fn === undefined) { throw new Error('no fn'); }
    const outcome = await kit.hub.run(start.fn, start.args, { kind: 'schedule/schedule', payload: fn.payload, run: kit.hub.runInfo(start.fn, { id: run }) });
    if (runOptions.settle === false) { return; }
    const status = outcome.status === 'done' ? 'done' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    await kit.hub.peer().call('event', { type: 'run', run, fn: start.fn, update: { type: 'status', status }, notified: runOptions.notified ?? false });
  };
  return {
    kit, clock, timer, held, runStarted,
    restart: async () => { if (ctx === undefined) throw new Error('not started'); await timer.start(ctx); },
    firings: () => kit.records('Firing').map((record) => ({ owner: record.owner, value: FiringShape.parse(record.value) })).sort((a, b) => a.value.at - b.value.at),
  };
}

/** An instant as the schedule fn's `at` travels: a gin timestamp's ISO text. */
const iso = (at: number): string => new Date(at).toISOString();

/** Mondays at 9:00, New York time. */
const MONDAYS = { dayOfWeek: [1], times: ['09:00'] };
/** Every day at 9:00. */
const DAILY = { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['09:00'] };
/** Monday 30 November 2026, 09:00 in New York (EST, UTC-5). */
const MON_9 = Date.UTC(2026, 10, 30, 14, 0);

describe('the schedule timer', () => {
  it('queues the next firing in its zone, starts it as its owner with its key, records it and tells the owner', async () => {
    const s = await served(MON_9 - 2 * HOUR, { orders_report: payload(MONDAYS) });
    expect(s.timer.store.schedule('schedule/orders_report')?.plannedAt).toBe(MON_9);
    s.clock.set(MON_9 + 5_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    expect(s.kit.hub.starts[0]).toEqual({ fn: 'schedule/orders_report', args: { at: iso(MON_9) }, key: `schedule:schedule/orders_report@${String(MON_9)}`, priority: 'background' });
    await s.runStarted(0);
    // the target got the firing's local day
    expect(s.kit.hub.calls.filter((call) => call.fn === TARGET).map((call) => call.args)).toEqual([{ day: '2026-11-30' }]);
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.ownerNotices[0]).toEqual({
      fn: 'schedule/orders_report',
      notice: {
        title: 'Orders report ran', body: '12 orders on 2026-11-30', tone: 'ok', key: 'schedule:schedule/orders_report',
        link: { run: s.kit.hub.startedRuns.get(s.kit.hub.starts[0]?.key ?? '')?.run },
        also: { label: 'History', link: { page: { system: 'schedule', segment: 'item', path: ['orders_report'], query: { tab: 'history' } } } },
      },
    });
    const [firing] = s.firings();
    expect(firing?.owner).toBe(TEST_USER.id);
    // saved by the system outside the run, naming its owner: a schedule of a read fn (a reminder) is declared read,
    // and the hub refuses a record saved in such a run (live run, slice 9); one record, updated as the firing went on
    expect(s.kit.records('Firing').map((record) => record.run)).toEqual([undefined]);
    expect(firing?.value).toMatchObject({ schedule: 'schedule/orders_report', at: MON_9, key: '2026-11-30T09:00', status: 'ran', manual: false, summary: '12 orders on 2026-11-30', notified: true, args: { day: '2026-11-30' } });
    // the next Monday is queued
    expect(s.timer.store.schedule('schedule/orders_report')?.plannedAt).toBe(MON_9 + 7 * 24 * HOUR);
  });

  it('plans across daylight saving: 9:00 stays 9:00, and 02:30 on the spring-forward night fires at 03:30', async () => {
    // Monday 2 November 2026, after clocks went back (EST): 9:00 is 14:00 UTC; in late October (EDT) it was 13:00 UTC
    const s = await served(Date.UTC(2026, 9, 26, 12, 0), { orders_report: payload(MONDAYS), early: payload({ on: '2027-03-14', times: ['02:30'] }) });
    expect(s.timer.store.schedule('schedule/orders_report')?.plannedAt).toBe(Date.UTC(2026, 9, 26, 13, 0));
    // 2027-03-14 is the spring-forward day in New York: 02:30 doesn't happen, so 03:30 EDT (07:30 UTC)
    expect(s.timer.store.schedule('schedule/early')?.plannedAt).toBe(Date.UTC(2027, 2, 14, 7, 30));
  });

  it('a doubled start is one run: the same key, and a replayed run is one firing record', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(MONDAYS) });
    // the schedule read again (another fns event) queues nothing new
    await s.kit.hub.peer().call('event', { type: 'fns', added: [], removed: [], changed: ['schedule/orders_report'] });
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    await s.runStarted(0, { settle: false });
    // the hub replays the same run (a restart): still one firing
    await s.runStarted(0);
    expect(new Set(s.kit.hub.starts.map((start) => start.key)).size).toBe(1);
    expect(s.firings()).toHaveLength(1);
  });

  it('after downtime, runs the latest missed firing once within the grace window and tells the rest in its notice', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY) });
    await s.timer.stop();
    // down from Monday 8:00 to Thursday 10:00: Mon, Tue, Wed 9:00 missed; Thursday's (1 h late) runs
    s.clock.set(MON_9 + 3 * 24 * HOUR + HOUR);
    await s.restart();
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    expect(s.kit.hub.starts[0]?.args).toEqual({ at: iso(MON_9 + 3 * 24 * HOUR) });
    await s.runStarted(0);
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.ownerNotices[0]?.notice).toMatchObject({ title: 'Orders report ran', body: 'Missed 3 runs before this one. 12 orders on 2026-12-03 (1 h late)' });
    expect(s.firings().map((f) => [f.value['key'], f.value['status']])).toEqual([
      ['2026-11-30T09:00', 'missed'], ['2026-12-01T09:00', 'missed'], ['2026-12-02T09:00', 'missed'], ['2026-12-03T09:00', 'ran'],
    ]);
  });

  it('after downtime past the grace window, records every firing as missed and tells them in one notice', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY) });
    await s.timer.stop();
    s.clock.set(MON_9 + 24 * HOUR + 7 * HOUR);
    await s.restart();
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.starts).toHaveLength(0);
    expect(s.kit.hub.ownerNotices[0]?.notice).toMatchObject({
      title: 'Orders report missed 2 runs', body: 'It couldn\'t start in time for 2 runs, the last on Tue, Dec 1 9:00 am.', tone: 'info',
      link: { page: { system: 'schedule', segment: 'item', path: ['orders_report'], query: { firing: '2026-12-01T09:00' } } },
    });
    expect(s.firings().map((f) => [f.value['status'], f.value['notified']])).toEqual([['missed', true], ['missed', true]]);
  });

  it('skips a firing due while the last one still runs, recorded and never told', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload({ dayOfWeek: [1], times: ['09:00', '09:30'] }) }, { hold: true });
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    const running = s.runStarted(0);
    await vi.waitFor(() => { expect(s.held).toHaveLength(1); });
    s.clock.set(MON_9 + 30 * MINUTE + 1_000);
    await vi.waitFor(() => { expect(s.firings().some((f) => f.value['status'] === 'skipped')).toBe(true); });
    expect(s.kit.hub.starts).toHaveLength(1);
    expect(s.firings().find((f) => f.value['status'] === 'skipped')?.value['summary']).toBe('The run before it (Mon, Nov 30 9:00 am) was still going.');
    s.held[0]?.settle({ status: 'done', result: { summary: 'done', total: 1 } });
    await running;
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.ownerNotices[0]?.notice.title).toBe('Orders report ran');
  });

  it('a firing waiting for approval gives up when its next firing is due, recorded as expired and told', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY) }, { hold: true });
    s.kit.hub.onControl = (control) => {
      const pending = s.held.shift();
      pending?.settle({ status: 'cancelled' });
      return Promise.resolve({ accepted: control.action === 'cancel' });
    };
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    const running = s.runStarted(0);
    await vi.waitFor(() => { expect(s.held).toHaveLength(1); });
    const pending = s.held[0];
    if (pending === undefined) throw new Error('no call');
    await s.kit.hub.peer().call('child', { parent: pending.call.parent, key: pending.call.key, run: 'run_child1', update: { type: 'status', status: 'awaiting-approval' } });
    await vi.waitFor(() => { expect(s.firings()[0]?.value['status']).toBe('waiting'); });
    // the next day's firing comes due: the wait ends
    s.clock.set(MON_9 + 24 * HOUR + 1_000);
    await running;
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices.length).toBeGreaterThanOrEqual(1); });
    const expired = s.firings()[0];
    expect(expired?.value).toMatchObject({ status: 'expired', summary: `It waited for approval to run ${TARGET} until its next run was due.` });
    expect(s.kit.hub.ownerNotices[0]?.notice).toMatchObject({ title: 'Orders report gave up waiting for approval', tone: 'failed' });
  });

  it('with approvals set to refuse, cancels a firing that needs approval at once and tells each reason once', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY) }, { hold: true, config: { approvals: 'refuse' } });
    s.kit.hub.onControl = () => {
      s.held.shift()?.settle({ status: 'cancelled' });
      return Promise.resolve({ accepted: true });
    };
    for (const [day, index] of [[0, 0], [1, 1]] as const) {
      s.clock.set(MON_9 + day * 24 * HOUR + 1_000);
      await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(index + 1); });
      const running = s.runStarted(index);
      await vi.waitFor(() => { expect(s.held).toHaveLength(1); });
      const pending = s.held[0];
      if (pending === undefined) throw new Error('no call');
      await s.kit.hub.peer().call('child', { parent: pending.call.parent, key: pending.call.key, run: `run_child${String(index)}`, update: { type: 'status', status: 'awaiting-approval' } });
      await running;
    }
    await vi.waitFor(() => { expect(s.firings().filter((f) => f.value['status'] === 'refused')).toHaveLength(2); });
    expect(s.kit.hub.ownerNotices.map((sent) => sent.notice.title)).toEqual(['Orders report was refused']);
  });

  it('does not tell a firing that ran when its run already told its person (a reminder), and tells a failure', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY, { notify: 'always' }) });
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    await s.runStarted(0, { notified: true });
    expect(s.firings()[0]?.value['status']).toBe('ran');
    // its record says the owner was notified (by the run itself)
    await vi.waitFor(() => { expect(s.firings()[0]?.value['notified']).toBe(true); });
    expect(s.kit.hub.ownerNotices).toHaveLength(0);
    s.kit.hub.onCall = (call) => Promise.resolve(call.fn === 'hub/fns_get'
      ? { status: 'done', result: { fn: TARGET, kind: 'native', description: 'Orders.', version: 1, available: true, args: TARGET_ARGS, returns: TARGET_RETURNS } }
      : { status: 'failed', error: { class: 'fatal', message: 'The orders table is locked.' } });
    s.clock.set(MON_9 + 24 * HOUR + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(2); });
    await s.runStarted(1, { notified: true });
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.ownerNotices[0]?.notice).toMatchObject({ title: 'Orders report failed', body: 'The orders table is locked.', tone: 'failed' });
  });

  it('a manual run ("run now") is recorded but never told, and needs its owner', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(MONDAYS) });
    const outcome = await s.kit.runKind('schedule', 'orders_report', typed(payload(MONDAYS)), {});
    expect(outcome.outcome.status).toBe('done');
    const [firing] = s.firings();
    expect(firing?.value).toMatchObject({ manual: true, status: 'ran', key: '2026-11-30T08:00' });
    expect(s.kit.hub.ownerNotices).toHaveLength(0);
    const other = await s.kit.runKind('schedule', 'orders_report', typed(payload(MONDAYS)), {}, { run: s.kit.hub.runInfo(QualifiedName.parse('schedule/orders_report'), { user: { ...TEST_USER, id: ActorId.parse('act_other') } }) });
    expect(other.outcome).toMatchObject({ status: 'failed', error: { class: 'caller' } });
  });

  it('refuses firings past the limits, with the reason, told once', async () => {
    const s = await served(MON_9 - HOUR, { a_report: payload(MONDAYS), b_report: payload(MONDAYS) }, { config: { perPerson: 1 } });
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.firings()).toHaveLength(1); });
    // the first one started (its record is written by its run); the second is past the limit
    expect(s.kit.hub.starts.map((start) => start.fn)).toEqual(['schedule/a_report']);
    const refused = s.firings().find((f) => f.value['status'] === 'refused');
    expect(refused?.value['schedule']).toBe('schedule/b_report');
    expect(refused?.value['summary']).toBe('Its owner has 2 schedules, more than the 1 one person may have, so the newest don\'t run.');
    expect(s.kit.hub.ownerNotices.map((sent) => [sent.fn, sent.notice.title])).toEqual([['schedule/b_report', 'Orders report was refused']]);
  });

  it('refuses firings past a person\'s firings per day', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload({ dayOfWeek: [1], times: ['09:00', '10:00'] }) }, { config: { firingsPerDay: 1 } });
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    await s.runStarted(0);
    s.clock.set(MON_9 + HOUR + 1_000);
    await vi.waitFor(() => { expect(s.firings().some((f) => f.value['status'] === 'refused')).toBe(true); });
    expect(s.kit.hub.starts).toHaveLength(1);
  });
});

/** `{ day: fire.local }`: the target gets the firing's instant as its zone's wall clock, with the offset. */
const LOCAL_ARGS = { kind: 'new', type: TARGET_ARGS, value: { day: { kind: 'get', path: [{ prop: 'fire' }, { prop: 'local' }] } } };

describe('zones and daylight saving, end to end', () => {
  /** Let the planned firing come due, run it as the hub would, and give what the target got. */
  async function fireNext(s: Served, index: number): Promise<{ at: number; day: string }> {
    const at = s.timer.store.schedule('schedule/nightly')?.plannedAt;
    if (at === undefined) throw new Error('nothing planned');
    s.clock.set(at + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(index + 1); });
    await s.runStarted(index);
    const call = s.kit.hub.calls.filter((c) => c.fn === TARGET).at(-1);
    return { at, day: DayArgs.parse(call?.args).day };
  }

  it('fires 02:30 every night across the spring-forward night: 03:30 that night, 02:30 again after, the offset in fire.local', async () => {
    // Saturday 13 March 2027, 00:00 in New York (EST); clocks go forward at 02:00 on Sunday the 14th
    const s = await served(Date.UTC(2027, 2, 13, 5, 0), { nightly: payload({ dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['02:30'] }, { args: LOCAL_ARGS }) });
    expect(await fireNext(s, 0)).toEqual({ at: Date.UTC(2027, 2, 13, 7, 30), day: '2027-03-13T02:30:00-05:00' });
    expect(await fireNext(s, 1)).toEqual({ at: Date.UTC(2027, 2, 14, 7, 30), day: '2027-03-14T03:30:00-04:00' });
    expect(await fireNext(s, 2)).toEqual({ at: Date.UTC(2027, 2, 15, 6, 30), day: '2027-03-15T02:30:00-04:00' });
    // each is one firing, recorded under the time it was planned for
    expect(s.firings().map((f) => [f.value.key, f.value.status])).toEqual([['2027-03-13T02:30', 'ran'], ['2027-03-14T02:30', 'ran'], ['2027-03-15T02:30', 'ran']]);
  });

  it('fires 01:30 once on the fall-back night, at the first one, and the next night at 01:30 standard time', async () => {
    // Saturday 31 October 2026, 00:00 in New York (EDT); clocks go back at 02:00 on Sunday 1 November, so 01:30 happens twice
    const s = await served(Date.UTC(2026, 9, 31, 4, 0), { nightly: payload({ dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['01:30'] }, { args: LOCAL_ARGS }) });
    expect(await fireNext(s, 0)).toEqual({ at: Date.UTC(2026, 9, 31, 5, 30), day: '2026-10-31T01:30:00-04:00' });
    expect(await fireNext(s, 1)).toEqual({ at: Date.UTC(2026, 10, 1, 5, 30), day: '2026-11-01T01:30:00-04:00' });
    // the second 01:30 that night (06:30 UTC) is not a firing: the next is Monday's, in standard time
    expect(s.timer.store.schedule('schedule/nightly')?.plannedAt).toBe(Date.UTC(2026, 10, 2, 6, 30));
  });

  it('reads a schedule in its own zone, not the host\'s or the person\'s: 9:00 in Tokyo is 00:00 UTC', async () => {
    const s = await served(Date.UTC(2026, 10, 29, 12, 0), { nightly: payload({ dayOfWeek: [1], times: ['09:00'] }, { zone: 'Asia/Tokyo', args: LOCAL_ARGS }) });
    // Monday 30 November 2026, 09:00 in Tokyo (UTC+9, no daylight saving) is Monday 00:00 UTC
    expect(await fireNext(s, 0)).toEqual({ at: Date.UTC(2026, 10, 30, 0, 0), day: '2026-11-30T09:00:00+09:00' });
  });
});

describe('across a restart', () => {
  it('skips a firing due while the run before it, started before the restart, still goes; the replayed run is recorded once', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload({ dayOfWeek: [1], times: ['09:00', '09:30'] }) }, { hold: true });
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    const run = s.kit.hub.startedRuns.get(s.kit.hub.starts[0]?.key ?? '')?.run;
    // the system goes down while the 9:00 run is still going on the hub, and comes back after 9:30
    await s.timer.stop();
    s.clock.set(MON_9 + 31 * MINUTE);
    await s.restart();
    await vi.waitFor(() => { expect(s.firings().some((f) => f.value.status === 'skipped')).toBe(true); });
    expect(s.kit.hub.starts).toHaveLength(1);
    expect(s.firings().find((f) => f.value.status === 'skipped')?.value).toMatchObject({ key: '2026-11-30T09:30', run, summary: 'The run before it (Mon, Nov 30 9:00 am) was still going.' });
    // the hub runs the 9:00 firing again after the restart: it settles as one firing
    const running = s.runStarted(0);
    await vi.waitFor(() => { expect(s.held).toHaveLength(1); });
    s.held[0]?.settle({ status: 'done', result: { summary: 'done', total: 1 } });
    await running;
    await vi.waitFor(() => { expect(s.firings().filter((f) => f.value.status === 'ran')).toHaveLength(1); });
    expect(s.firings().map((f) => f.value.status)).toEqual(['ran', 'skipped']);
  });

  it('with missed set to none, records every firing missed while it was down, runs none late, and goes on with the next', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY, { missed: 'none' }) });
    await s.timer.stop();
    // down from Monday 8:00 to Tuesday 9:30, within the grace window: Monday's and Tuesday's are missed all the same
    s.clock.set(MON_9 + 24 * HOUR + 30 * MINUTE);
    await s.restart();
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.starts).toHaveLength(0);
    expect(s.kit.hub.ownerNotices[0]?.notice).toMatchObject({ title: 'Orders report missed 2 runs' });
    expect(s.firings().map((f) => [f.value.key, f.value.status, f.value.summary])).toEqual([
      ['2026-11-30T09:00', 'missed', 'It couldn\'t start on time (Mon, Nov 30 9:00 am), and missed runs don\'t run late.'],
      ['2026-12-01T09:00', 'missed', 'It couldn\'t start on time (Tue, Dec 1 9:00 am), and missed runs don\'t run late.'],
    ]);
    expect(s.timer.store.schedule('schedule/orders_report')?.plannedAt).toBe(MON_9 + 2 * 24 * HOUR);
    s.clock.set(MON_9 + 2 * 24 * HOUR + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    expect(s.kit.hub.starts[0]?.args).toEqual({ at: iso(MON_9 + 2 * 24 * HOUR) });
  });
});

describe('the start gate', () => {
  it('records a refused start with the hub\'s reason, tells the owner once per reason and the admins once when the owner is gone', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(DAILY) });
    let refusal = { status: 403, code: 'OWNER_GONE', message: 'Its owner can no longer use the hub.' };
    s.kit.hub.onStartRun = () => { throw reject(refusal.status, refusal.code, refusal.message); };
    for (const day of [0, 1]) {
      s.clock.set(MON_9 + day * 24 * HOUR + 1_000);
      await vi.waitFor(() => { expect(s.firings().filter((f) => f.value.status === 'refused')).toHaveLength(day + 1); });
    }
    expect(s.firings().map((f) => f.value.summary)).toEqual(['The hub refused to start it: Its owner can no longer use the hub.', 'The hub refused to start it: Its owner can no longer use the hub.']);
    expect(s.kit.hub.ownerNotices.map((sent) => sent.notice.title)).toEqual(['Orders report was refused']);
    expect(s.kit.hub.notices).toHaveLength(1);
    // another reason is told again, under the same key (it replaces the unread one)
    refusal = { status: 403, code: 'DENIED', message: 'Not allowed: no reports on weekends.' };
    s.clock.set(MON_9 + 2 * 24 * HOUR + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(2); });
    expect(s.kit.hub.ownerNotices.map((sent) => sent.notice.key)).toEqual(['schedule:schedule/orders_report', 'schedule:schedule/orders_report']);
    expect(s.kit.hub.notices).toHaveLength(1);
    expect(s.firings().every((f) => f.value.run === undefined)).toBe(true);
  });

  it('tries a start the hub couldn\'t answer again with the same key: one run, one firing', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(MONDAYS) });
    let down = true;
    s.kit.hub.onStartRun = () => { if (down) { throw new Error('The hub is restarting.'); } };
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(1); });
    expect(s.firings()).toHaveLength(0);
    down = false;
    s.clock.set(MON_9 + 2_000);
    await vi.waitFor(() => { expect(s.kit.hub.starts).toHaveLength(2); });
    expect(new Set(s.kit.hub.starts.map((start) => start.key))).toEqual(new Set([`schedule:schedule/orders_report@${String(MON_9)}`]));
    await s.runStarted(1);
    expect(s.firings().map((f) => [f.value.status, f.value.summary])).toEqual([['ran', '12 orders on 2026-11-30']]);
    expect(s.kit.hub.startedRuns.size).toBe(1);
  });
});

describe('a start the hub ends at once (live run, slice 9)', () => {
  it('sends the planned instant as the gin timestamp’s ISO text, and records and tells a run the hub refused before it answered', async () => {
    const s = await served(MON_9 - HOUR, { orders_report: payload(MONDAYS) });
    // the hub checks the schedule fn's args and ends the run in the start itself, before the firing knows its run
    s.kit.hub.onStartRun = (start) => {
      const { at } = z.object({ at: z.unknown() }).parse(start.args);
      if (typeof at !== 'string') { throw new Error('at should travel as ISO text'); }
      s.kit.hub.startedRuns.set(start.key, { run: RunId.parse('run_refused1'), turn: TurnId.parse('trn_refused1'), status: 'invalid-input' });
    };
    s.clock.set(MON_9 + 1_000);
    await vi.waitFor(() => { expect(s.firings()).toHaveLength(1); });
    expect(s.firings()[0]?.value).toMatchObject({ status: 'failed', run: 'run_refused1', summary: 'The hub refused the args it was started with, so it never ran.' });
    await vi.waitFor(() => { expect(s.kit.hub.ownerNotices).toHaveLength(1); });
    expect(s.kit.hub.ownerNotices[0]?.notice).toMatchObject({ title: 'Orders report failed', tone: 'failed' });
    // the next Monday is planned as before
    expect(s.timer.store.schedule('schedule/orders_report')?.plannedAt).toBe(MON_9 + 7 * 24 * HOUR);
  });
});

describe('the schedule kind', () => {
  it('checks the gap between times against the config, the target and the args program', async () => {
    const s = await served(MON_9, {}, { config: { minGap: 30 * MINUTE } });
    s.kit.hub.onFnShape = (name) => Promise.resolve(name === TARGET ? { fn: { args: TARGET_ARGS, returns: TARGET_RETURNS, description: 'Orders.', mode: 'read' } } : {});
    const base = { fn: TARGET, zone: 'America/New_York', args: DAY_ARGS, notify: 'always', overlap: 'skip', missed: 'latest' };
    const ok = await s.kit.kindProps('schedule', typed({ ...base, when: { dayOfWeek: [1], times: ['09:00'] } }));
    expect(ok.problems).toEqual([]);
    expect(ok.description).toMatchObject({ deps: [TARGET, 'hub/fns_get'], returns: TARGET_RETURNS, effects: { mode: 'read' } });
    const close = await s.kit.kindProps('schedule', typed({ ...base, when: { dayOfWeek: [1], times: ['09:00', '09:15'] } }));
    expect(close.problems).toEqual(['09:00 and 09:15 are less than 30 minutes apart, the shortest gap between two runs.']);
    const unknown = await s.kit.kindProps('schedule', typed({ ...base, fn: 'demo/nope', when: { on: '2026-12-01' } }));
    expect(unknown.problems[0]).toContain('demo/nope is not a fn its owner can run');
    const calls = await s.kit.kindProps('schedule', typed({
      ...base, when: { on: '2026-12-01' },
      args: { kind: 'new', type: TARGET_ARGS, value: { day: { kind: 'get', path: [{ prop: 'fns' }, { prop: 'demo' }, { prop: 'today' }, { args: {} }] } } },
    }));
    expect(calls.problems[0]).toContain('calls no fns');
  });
});

