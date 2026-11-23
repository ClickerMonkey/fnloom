/**
 * The schedule system's chat fns with the SDK's fake hub, a fake clock and a scripted model: `add` with fixed args
 * (saved as a literal program, the view's words, next runs and first args, its undo) and with `compute` (the authoring
 * step's forced workflow, a fixed value kept, a failed check fixed, the three previews); what `add` refuses (a gap, a
 * time in the past, an unknown fn, a schedule as the target, the per-person limit); `change`, `pause`, `resume` and
 * `skip` as new versions with the version before as their undo (an unchanged one saves nothing); `remove` through
 * `hub/fns_remove`; someone else's schedule refused (an admin may pause it); `list` and `history` over the timer and
 * the firing records; and `remind`, which notifies its own person.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Json, QualifiedName, type KindFnWire, type LlmForward, type RunSettled } from '@harness/core';
import { hub, wireType, type Infer } from '@harness/sdk';
import { mockModel, TEST_USER, testHub, toolCall, type ScriptStep, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SchedulePayload, schedule, type AddArgs, type ScheduleConfigInput } from '../shared/index.ts';
import { ARGS_EXAMPLES } from './authoring.ts';
import { scheduleEnv } from './env.ts';
import { fixedOf, localNameOf, slugOf } from './fns.ts';
import { createScheduleImpl } from './impl.ts';
import { Timer, type Clock } from './timer.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A clock the test sets. */
class FakeClock implements Clock {
  t: number;
  constructor(t: number) { this.t = t; }
  now(): number { return this.t; }
}

/** Monday 23 November 2026, 08:00 in New York (EST, UTC-5). */
const MON_8 = Date.UTC(2026, 10, 23, 13, 0);
const NEW_YORK = { ...TEST_USER, timeZone: 'America/New_York', role: 'member' as const };

const TARGET = QualifiedName.parse('demo/orders_report');
const TARGET_ARGS = { name: 'obj', props: { day: { type: { name: 'text' } }, limit: { type: { name: 'num' } } } };
const TARGET_RETURNS = { name: 'obj', props: { summary: { type: { name: 'text' } } } };
const MONDAYS = { dayOfWeek: [1], times: ['09:00'] };
/** A hub fn's `{ fn }` args, and a kept fn as `hub/fns_get` gives it. */
const FnArg = z.object({ fn: z.string() });
const Stored = z.record(z.string(), Json);

type Kit = TestSystem<'schedule', (typeof schedule)['defs']>;

const done = (result: unknown): RunSettled => ({ status: 'done', result: Json.parse(result) });
const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

interface Served {
  readonly kit: Kit;
  readonly clock: FakeClock;
  /** Who owns the fns `hub/fns_get` gives (absent: the hub gives none, as for a fn of the run's person in the fake). */
  owner: string | undefined;
  /** The fns `hub/fns_remove` removed. */
  readonly removed: string[];
  /** The timer lists the kept schedules (as `kindFns` would once the hub's `fns` event comes). */
  sync(): Promise<void>;
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) { await step(); }
  cleanup = [];
});

async function served(options: { script?: readonly ScriptStep[]; config?: ScheduleConfigInput } = {}): Promise<Served> {
  const clock = new FakeClock(MON_8);
  const dir = mkdtempSync(join(tmpdir(), 'schedule-fns-'));
  const settings = { ...scheduleEnv.parse(), SCHEDULE_DB: join(dir, 'timer.db'), SCHEDULE_POLL: 10 };
  const timer = new Timer({ settings, clock });
  const kit = await testHub(schedule, createScheduleImpl({ settings, clock, timer }), { config: options.config ?? {}, model: mockModel(options.script ?? []) });
  cleanup.push(async () => { await kit.stop(); await timer.stop(); rmSync(dir, { recursive: true, force: true }); });
  const removed: string[] = [];
  const state: Served = {
    kit, clock, owner: undefined, removed,
    async sync() {
      kit.hub.kindFns = [...kit.hub.fns.kept.values()].map((kept): KindFnWire => ({
        fn: QualifiedName.parse(kept.fn), kind: schedule.kinds.schedule.name, owner: TEST_USER.id, title: kept.saved.name, version: kept.version,
        payload: kept.saved.payload, removed: false, updatedAt: clock.now(),
      }));
      await kit.hub.peer().call('event', { type: 'fns', added: kit.hub.kindFns.map((fn) => fn.fn), removed: [], changed: [] });
    },
  };
  kit.hub.onCall = (call) => {
    const asked = call.fn === hub.fns.fns_get.name ? FnArg.parse(call.args).fn : undefined;
    if (asked === TARGET) {
      return Promise.resolve(done({ fn: TARGET, kind: 'native', description: 'Orders of a day.', version: 1, available: true, args: TARGET_ARGS, returns: TARGET_RETURNS }));
    }
    if (asked === schedule.fns.remind.name) {
      const remind = schedule.fns.remind;
      return Promise.resolve(done({ fn: remind.name, kind: 'native', description: 'Notify the person.', version: 1, available: true, args: wireType(remind.args), returns: wireType(remind.returns) }));
    }
    if (call.fn === hub.fns.fns_remove.name) {
      const { fn } = FnArg.parse(call.args);
      const kept = kit.hub.fns.kept.get(fn);
      if (kept === undefined) { return Promise.resolve({ status: 'failed', error: { class: 'caller', message: `No such fn: ${fn}.` } }); }
      kit.hub.fns.kept.delete(fn);
      removed.push(fn);
      return Promise.resolve(done({ fn, version: kept.version }));
    }
    const settled = kit.hub.fns.settle(call);
    if (settled?.status === 'done' && asked !== undefined && state.owner !== undefined) {
      return Promise.resolve(done({ ...Stored.parse(settled.result), owner: state.owner }));
    }
    return Promise.resolve(settled ?? { status: 'failed', error: { class: 'caller', message: `No answer for ${call.fn}.` } });
  };
  return state;
}

/** A run of one of the fns as the New York person. */
const asPerson = (kit: Kit, fn: string, user: typeof NEW_YORK | typeof TEST_USER = NEW_YORK) => ({ run: kit.hub.runInfo(QualifiedName.parse(`schedule/${fn}`), { user, time: { now: MON_8, timeZone: user.timeZone, local: '' } }) });

/** The payload kept for a schedule. */
const keptPayload = (s: Served, fn: string): SchedulePayload => SchedulePayload.parse(s.kit.hub.fns.kept.get(fn)?.saved.payload);

describe('schedule/add', () => {
  it('saves a schedule with fixed args as a literal program and answers with its words, next runs and first args', async () => {
    const s = await served();
    const run = await s.kit.run('add', { fn: TARGET, when: MONDAYS, args: { day: 'latest', limit: 5 } }, asPerson(s.kit, 'add'));
    expect(run.outcome).toMatchObject({
      status: 'done',
      result: {
        schedule: 'schedule/orders_report', fn: TARGET, says: 'Every week on Monday at 9:00 am', zone: 'America/New_York', notify: 'always',
        next: [{ at: MON_8 + HOUR, local: 'Mon, Nov 23 9:00 am' }, { at: MON_8 + HOUR + 7 * DAY, local: 'Mon, Nov 30 9:00 am' }, { local: 'Mon, Dec 7 9:00 am' }],
        firstArgs: { day: 'latest', limit: 5 },
      },
      undo: { schedule: 'schedule/orders_report' },
    });
    const kept = s.kit.hub.fns.kept.get('schedule/orders_report');
    expect(kept?.saved).toMatchObject({ kind: 'schedule/schedule', name: 'orders_report', tags: ['schedules'] });
    expect(kept?.saved.description).toBe('Every week on Monday at 9:00 am (America/New_York), runs demo/orders_report.');
    const payload = keptPayload(s, 'schedule/orders_report');
    expect(payload).toMatchObject({ fn: TARGET, zone: 'America/New_York', notify: 'always', overlap: 'skip', missed: 'latest' });
    expect(fixedOf(payload)).toEqual({ day: 'latest', limit: 5 });
    // a second one of the same fn gets the next free name; one named in words is named for them
    await s.kit.call('add', { fn: TARGET, when: { dayOfWeek: [5], times: ['17:00'] }, args: { day: 'latest', limit: 5 } }, asPerson(s.kit, 'add'));
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 }, name: 'Weekly orders summary', notify: 'failed', zone: 'Europe/Paris' }, asPerson(s.kit, 'add'));
    expect([...s.kit.hub.fns.kept.keys()]).toEqual(['schedule/orders_report', 'schedule/orders_report_2', 'schedule/weekly_orders_summary']);
    // in a zone other than the person's, the words say whose time it is
    const paris = await s.kit.call('change', { schedule: 'schedule/weekly_orders_summary', notify: 'always' }, asPerson(s.kit, 'change'));
    expect(paris.result.says).toBe('Every week on Monday at 9:00 am, Paris time');
  });

  it('writes args that change with each run from words: the forced workflow, a fixed value kept, three previews', async () => {
    const limit = (value: number) => ({ kind: 'new', type: { name: 'num' }, value });
    const good = { ...ARGS_EXAMPLES.lastWeek.program, type: TARGET_ARGS, value: { day: ARGS_EXAMPLES.lastWeek.program.value.from, limit: limit(5) } };
    const wrongLimit = { ...good, value: { ...good.value, limit: limit(10) } };
    const s = await served({
      script: [
        toolCall('examples', {}),
        toolCall('set', { draft: { program: wrongLimit } }),
        toolCall('set', { draft: { program: good } }),
        toolCall('return', {}),
        'Kept the args.',
      ],
    });
    const { result } = await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { limit: 5 }, compute: 'day: the run\'s day minus 7 days' }, asPerson(s.kit, 'add'));
    expect(result.firstArgs).toEqual({ day: '2026-11-16', limit: 5 });
    const payload = keptPayload(s, 'schedule/orders_report');
    expect(payload.argsAsked).toBe('day: the run\'s day minus 7 days');
    expect(fixedOf(payload)).toBeUndefined();
    const forwards = s.kit.hub.forwards;
    // examples first and alone; set after it; return only after a clean check
    expect(offered(forwards[0])).toEqual(['examples']);
    expect(offered(forwards[1])).toContain('set');
    expect(offered(forwards[2])).not.toContain('return');
    expect(offered(forwards[3])).toContain('return');
    const request = JSON.stringify(forwards[0]?.request.messages);
    expect(request).toContain('demo/orders_report(day: text, limit: num)');
    expect(request).toContain('Fixed values, kept as given: {\\"limit\\":5}');
    expect(request).toContain('Mon, Nov 23 9:00 am; Mon, Nov 30 9:00 am; Mon, Dec 7 9:00 am');
    // the changed fixed value was a problem the model read; the clean draft showed each run's args
    expect(JSON.stringify(forwards[2]?.request.messages)).toContain('value.limit: it was given as 5');
    const clean = JSON.stringify(forwards[3]?.request.messages);
    expect(clean).toContain('Mon, Nov 30 9:00 am: {\\"day\\":\\"2026-11-23\\",\\"limit\\":5}');
    expect(clean).toContain('Mon, Dec 7 9:00 am: {\\"day\\":\\"2026-11-30\\",\\"limit\\":5}');
  });

  it('says why the words could not be turned into args, by the field', async () => {
    const s = await served({ script: [toolCall('examples', {}), 'Those args depend on another fn.'] });
    const run = await s.kit.run('add', { fn: TARGET, when: MONDAYS, compute: 'day: the day the last order came in' }, asPerson(s.kit, 'add'));
    expect(run.outcome).toMatchObject({ status: 'invalid-input' });
    expect(JSON.stringify(run.outcome)).toContain('"path":"compute"');
    expect(s.kit.hub.fns.kept.size).toBe(0);
  });

  it('refuses times closer than the gap, a time already past, an unknown fn, a schedule as the fn, and too many schedules', async () => {
    const s = await served({ config: { perPerson: 1 } });
    const outcome = async (args: Infer<typeof AddArgs>): Promise<string> => JSON.stringify((await s.kit.run('add', args, asPerson(s.kit, 'add'))).outcome);
    expect(await outcome({ fn: TARGET, when: { dayOfWeek: [1], times: ['09:00', '09:05'] }, args: { day: 'x', limit: 1 } })).toContain('less than 15 minutes apart');
    expect(await outcome({ fn: TARGET, when: { on: '2026-11-20', times: ['09:00'] }, args: { day: 'x', limit: 1 } })).toContain('It would never run');
    expect(await outcome({ fn: 'demo/nothing_here', when: MONDAYS })).toContain('is not a fn the person can run');
    expect(await outcome({ fn: TARGET, when: MONDAYS, args: { day: 3 } })).toContain('"path":"args"');
    expect(s.kit.hub.fns.kept.size).toBe(0);
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    expect(await outcome({ fn: 'schedule/orders_report', when: MONDAYS })).toContain('is a schedule itself');
    await s.sync();
    expect(await outcome({ fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } })).toContain('the most one person may have (1)');
  });
});

describe('changing a schedule', () => {
  async function withOne(): Promise<Served> {
    const s = await served();
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    return s;
  }
  const NAME = 'schedule/orders_report';

  it('saves each change as a new version, the one before as its undo; an unchanged one saves nothing', async () => {
    const s = await withOne();
    const changed = await s.kit.run('change', { schedule: NAME, when: { dayOfWeek: [1, 4], times: ['09:00'] }, args: { day: 'y', limit: 2 } }, asPerson(s.kit, 'change'));
    expect(changed.outcome).toMatchObject({ status: 'done', result: { says: 'On Monday and Thursday at 9:00 am', firstArgs: { day: 'y', limit: 2 } }, undo: { schedule: NAME, version: 1 } });
    expect(s.kit.hub.fns.kept.get(NAME)).toMatchObject({ version: 2, history: [{ name: 'orders_report' }] });
    const same = await s.kit.run('change', { schedule: NAME, notify: 'always' }, asPerson(s.kit, 'change'));
    expect(same.outcome).toMatchObject({ status: 'done' });
    expect(same.outcome).not.toHaveProperty('undo');
    expect(s.kit.hub.fns.kept.get(NAME)?.version).toBe(2);
    const undone = await s.kit.hub.peer().call('undo', { run: s.kit.hub.runInfo(QualifiedName.parse('schedule/change')), fn: 'change', kind: 'native', payload: { schedule: NAME, version: 1 } });
    expect(undone).toEqual({ status: 'undone', summary: `${NAME} goes back to version 1` });
  });

  it('pauses (until a day, or until resumed), resumes and skips one run, each a new version', async () => {
    const s = await withOne();
    const paused = await s.kit.call('pause', { schedule: NAME }, asPerson(s.kit, 'pause'));
    expect(paused.result).toMatchObject({ paused: {}, next: [] });
    expect(keptPayload(s, NAME).paused).toMatchObject({ at: MON_8, by: TEST_USER.id });
    const until = await s.kit.call('pause', { schedule: NAME, until: '2026-12-05' }, asPerson(s.kit, 'pause'));
    expect(until.result).toMatchObject({ paused: { until: '2026-12-05' }, next: [{ local: 'Mon, Dec 7 9:00 am' }, { local: 'Mon, Dec 14 9:00 am' }, { local: 'Mon, Dec 21 9:00 am' }] });
    expect(JSON.stringify((await s.kit.run('pause', { schedule: NAME, until: '2026-11-23' }, asPerson(s.kit, 'pause'))).outcome)).toContain('is not after today');
    const resumed = await s.kit.call('resume', { schedule: NAME }, asPerson(s.kit, 'resume'));
    expect(resumed.result.paused).toBeUndefined();
    expect(keptPayload(s, NAME).paused).toBeUndefined();
    const skipped = await s.kit.run('skip', { schedule: NAME, day: '2026-11-30' }, asPerson(s.kit, 'skip'));
    expect(skipped.outcome).toMatchObject({ status: 'done', result: { next: [{ local: 'Mon, Nov 23 9:00 am' }, { local: 'Mon, Dec 7 9:00 am' }, { local: 'Mon, Dec 14 9:00 am' }] }, undo: { schedule: NAME, version: 4 } });
    expect(keptPayload(s, NAME).when.exclude).toEqual(['2026-11-30']);
    expect(s.kit.hub.fns.kept.get(NAME)?.version).toBe(5);
    expect(JSON.stringify((await s.kit.run('skip', { schedule: NAME, day: '2026-12-01' }, asPerson(s.kit, 'skip'))).outcome)).toContain('has no run on 2026-12-01');
    expect(JSON.stringify((await s.kit.run('skip', { schedule: NAME, day: '2026-12-07', time: '10:00' }, asPerson(s.kit, 'skip'))).outcome)).toContain('runs on 2026-12-07 at 09:00, not at 10:00');
  });

  it('removes it through hub/fns_remove, with the version it had as its undo', async () => {
    const s = await withOne();
    const run = await s.kit.run('remove', { schedule: NAME }, asPerson(s.kit, 'remove'));
    expect(run.outcome).toMatchObject({ status: 'done', result: { removed: NAME }, undo: { schedule: NAME, version: 1 } });
    expect(s.removed).toEqual([NAME]);
    expect(JSON.stringify((await s.kit.run('remove', { schedule: NAME }, asPerson(s.kit, 'remove'))).outcome)).toContain('is not a schedule of the person\'s');
  });

  it('refuses someone else\'s schedule, except a pause or resume by an admin', async () => {
    const s = await withOne();
    s.owner = 'act_someone_else';
    expect(JSON.stringify((await s.kit.run('change', { schedule: NAME, notify: 'never' }, asPerson(s.kit, 'change'))).outcome)).toContain('runs as the person who made it');
    expect(JSON.stringify((await s.kit.run('pause', { schedule: NAME }, asPerson(s.kit, 'pause'))).outcome)).toContain('runs as the person who made it');
    const admin = await s.kit.run('pause', { schedule: NAME }, asPerson(s.kit, 'pause', TEST_USER));
    expect(admin.outcome).toMatchObject({ status: 'done', result: { paused: {} } });
  });
});

describe('reading schedules', () => {
  it('lists the person\'s schedules with how the last run went, filtered, and pages their history', async () => {
    const s = await served();
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    await s.kit.call('add', { fn: schedule.fns.remind.name, when: { on: '2026-12-01', times: ['08:30'] }, args: { text: 'Renew the domain name.' } }, asPerson(s.kit, 'add'));
    await s.kit.call('pause', { schedule: 'schedule/orders_report' }, asPerson(s.kit, 'pause'));
    await s.sync();
    const firing = (at: number, status: string, summary: string) => ({ schedule: 'schedule/orders_report', version: 1, at, key: '2026-11-16T09:00', manual: false, status, summary, notified: true });
    s.kit.hub.data.save({ type: schedule.types.Firing.name, value: firing(MON_8 - 7 * DAY + HOUR, 'ran', '12 orders'), owner: TEST_USER.id });
    s.kit.hub.data.save({ type: schedule.types.Firing.name, value: firing(MON_8 - 14 * DAY + HOUR, 'failed', 'It failed.'), owner: TEST_USER.id });
    const all = await s.kit.call('list', {}, asPerson(s.kit, 'list'));
    expect(all.result.items.map((item) => item.schedule)).toEqual(['schedule/orders_report', 'schedule/reminder_renew_the_domain_name']);
    expect(all.result.items[0]).toMatchObject({ paused: {}, next: [], last: { status: 'ran', summary: '12 orders' } });
    expect(all.result.items[1]).toMatchObject({ says: 'Once, on Tue, Dec 1 at 8:30 am', next: [{ local: 'Tue, Dec 1 8:30 am' }] });
    expect((await s.kit.call('list', { paused: false }, asPerson(s.kit, 'list'))).result.items.map((item) => item.schedule)).toEqual(['schedule/reminder_renew_the_domain_name']);
    expect((await s.kit.call('list', { fn: TARGET }, asPerson(s.kit, 'list'))).result.items).toHaveLength(1);
    expect((await s.kit.call('list', { search: 'renew domain' }, asPerson(s.kit, 'list'))).result.items).toHaveLength(1);
    const history = await s.kit.call('history', { schedule: 'schedule/orders_report' }, asPerson(s.kit, 'history'));
    expect(history.result.items.map((item) => item.status)).toEqual(['ran', 'failed']);
    expect((await s.kit.call('history', { status: 'failed' }, asPerson(s.kit, 'history'))).result.items.map((item) => item.summary)).toEqual(['It failed.']);
    expect((await s.kit.call('history', { from: new Date(MON_8 - 8 * DAY) }, asPerson(s.kit, 'history'))).result.items).toHaveLength(1);
  });

  it('names schedules from their words, a reminder from its text, else the fn they run', () => {
    expect(slugOf('Weekly Orders: summary!')).toBe('weekly_orders_summary');
    expect(slugOf('2 a day')).toBe('schedule_2_a_day');
    expect(localNameOf({ fn: QualifiedName.parse('database/main.orders_by_week') })).toBe('main_orders_by_week');
    expect(localNameOf({ fn: schedule.fns.remind.name, fixed: { text: 'Take the bins out tonight please now' } })).toBe('reminder_take_the_bins_out_tonight');
  });
});

describe('schedule/remind', () => {
  it('notifies its own person with the text', async () => {
    const s = await served();
    const { result } = await s.kit.call('remind', { text: 'Send the status note.' });
    expect(result).toEqual({ sent: true });
    expect(s.kit.hub.runNotices).toMatchObject([{ notice: { title: 'Reminder', body: 'Send the status note.', tone: 'info' } }]);
  });
});
