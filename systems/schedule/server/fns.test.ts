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
import { examplesChecked, mockModel, TEST_USER, testHub, toolCall, type ScriptStep, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SchedulePayload, schedule, type AddArgs, type ChangeArgs, type ScheduleConfigInput } from '../shared/index.ts';
import { ARGS_EXAMPLES } from './authoring.ts';
import { scheduleEnv } from './env.ts';
import { fixedOf, fromPairs, localNameOf, slugOf } from './fns.ts';
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
  /** What `hub/fns_allow_runs` was asked, in order. */
  readonly allowed: Array<{ fn: string; allow: boolean }>;
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
  const allowed: Served['allowed'] = [];
  const state: Served = {
    kit, clock, owner: undefined, removed, allowed,
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
    if (call.fn === hub.fns.fns_allow_runs.name) {
      const asked = z.object({ fn: z.string(), allow: z.boolean() }).parse(call.args);
      allowed.push(asked);
      return Promise.resolve(done({ fn: asked.fn, allowed: asked.allow }));
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

  it('reads fixed args a strict tool schema sent as { key, value } pairs as the object they spell (live run, slice 9)', async () => {
    // OpenAI's strict mode has no open object, so a free-form JSON arg arrives as a list of pairs, at any depth
    expect(fromPairs([{ key: 'text', value: 'Call the dentist.' }])).toEqual({ text: 'Call the dentist.' });
    expect(fromPairs([{ key: 'filter', value: [{ key: 'day', value: 'x' }] }, { key: 'tags', value: ['a', 'b'] }])).toEqual({ filter: { day: 'x' }, tags: ['a', 'b'] });
    expect(fromPairs([{ key: 'a', value: 1, extra: true }])).toEqual([{ key: 'a', value: 1, extra: true }]);
    expect(fromPairs([])).toEqual([]);
    const s = await served();
    const { result } = await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: [{ key: 'day', value: 'latest' }, { key: 'limit', value: 5 }] }, asPerson(s.kit, 'add'));
    expect(result.firstArgs).toEqual({ day: 'latest', limit: 5 });
    expect(fixedOf(keptPayload(s, 'schedule/orders_report'))).toEqual({ day: 'latest', limit: 5 });
    const changed = await s.kit.call('change', { schedule: 'schedule/orders_report', args: [{ key: 'day', value: 'x' }, { key: 'limit', value: 1 }] }, asPerson(s.kit, 'change'));
    expect(changed.result.firstArgs).toEqual({ day: 'x', limit: 1 });
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
    // every example call the prompts showed reads back through the tool it shows, written for each schema dialect
    const examples = examplesChecked(s.kit.hub.sent);
    expect(examples.problems).toEqual([]);
    expect(examples.values).toBeGreaterThan(0);
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

describe('the args check the hub asks before the approval card (live run, slice 9: wrong args waited on a card)', () => {
  /** The problems `add` or `change`'s check finds, as path: message lines, and whether it saved or asked a model. */
  const lines = (problems: readonly { path: string; message: string }[]): string[] => problems.map((problem) => `${problem.path}: ${problem.message}`);

  it('refuses add\'s fixed args that don\'t fit the target\'s args type, by path, before any card, saving nothing', async () => {
    const s = await served();
    const wrong = await s.kit.check('add', { fn: TARGET, when: MONDAYS, args: { day: 3 } }, asPerson(s.kit, 'add'));
    // concise lines, each at its path with what was expected there, as the hub words a call's own args
    expect(wrong.problems.map((problem) => problem.path)).toEqual(['args.day', 'args.limit']);
    expect(lines(wrong.problems).join(' ')).toMatch(/args\.day: .*text|string/);
    // it read the target's signature with hub/fns_get, under its own keys, and changed nothing
    expect(wrong.hubCalls.calls.map((call) => [call.fn, call.key])).toEqual([[hub.fns.fns_get.name, 'check:getFn#1']]);
    expect(s.kit.hub.fns.kept.size).toBe(0);
    expect(s.kit.hub.forwards).toHaveLength(0);
    // the pairs a strict tool schema sends are read as the object they spell, and args that fit pass
    expect((await s.kit.check('add', { fn: TARGET, when: MONDAYS, args: [{ key: 'day', value: 'latest' }, { key: 'limit', value: 5 }] }, asPerson(s.kit, 'add'))).problems).toEqual([]);
    expect(lines((await s.kit.check('add', { fn: TARGET, when: MONDAYS, args: 'day=latest' }, asPerson(s.kit, 'add'))).problems)).toEqual(['args: demo/orders_report takes its args as an object: give them by name.']);
  });

  it('refuses an unknown or unusable target, a time already past, a gap too small and too many schedules', async () => {
    const s = await served({ config: { perPerson: 1 } });
    const check = async (args: Infer<typeof AddArgs>): Promise<string[]> => lines((await s.kit.check('add', args, asPerson(s.kit, 'add'))).problems);
    expect((await check({ fn: 'demo/nothing_here', when: MONDAYS })).join(' ')).toContain('fn: demo/nothing_here is not a fn the person can run');
    expect((await check({ fn: TARGET, when: { on: '2026-11-20', times: ['09:00'] }, args: { day: 'x', limit: 1 } })).join(' ')).toContain('when: It would never run');
    expect((await check({ fn: TARGET, when: { dayOfWeek: [1], times: ['09:00', '09:05'] }, args: { day: 'x', limit: 1 } })).join(' ')).toContain('less than 15 minutes apart');
    // args worked out from words are a model call, made after the card: only the target and when are checked first
    expect(await check({ fn: TARGET, when: MONDAYS, compute: 'day: the run\'s day minus 7 days' })).toEqual([]);
    expect(s.kit.hub.forwards).toHaveLength(0);
    expect((await check({ fn: TARGET, when: { dayOfWeek: [1], times: ['09:00', '09:05'] }, compute: 'day: the run\'s day' })).join(' ')).toContain('when.times:');
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    await s.sync();
    expect(await check({ fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } })).toEqual([`: The person has 1 schedules, the most one person may have (1): remove one first (${schedule.fns.remove.name}).`]);
  });

  it('refuses change\'s fixed args against the target\'s args type, someone else\'s schedule and a when that never runs', async () => {
    const s = await served();
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    const NAME = 'schedule/orders_report';
    const check = async (args: Infer<typeof ChangeArgs>): Promise<string[]> => lines((await s.kit.check('change', args, asPerson(s.kit, 'change'))).problems);
    expect((await check({ schedule: NAME, args: { day: 3 } })).map((line) => line.split(':')[0])).toEqual(['args.day', 'args.limit']);
    expect(await check({ schedule: NAME, args: { day: 'y', limit: 2 } })).toEqual([]);
    expect(await check({ schedule: NAME, notify: 'never' })).toEqual([]);
    expect((await check({ schedule: NAME, when: { on: '2026-11-20', times: ['09:00'] } })).join(' ')).toContain('It would never run');
    expect((await check({ schedule: 'schedule/nope' })).join(' ')).toContain('schedule: schedule/nope is not a schedule of the person\'s');
    expect(s.kit.hub.fns.kept.get(NAME)?.version).toBe(1);
    s.owner = 'act_someone_else';
    expect((await check({ schedule: NAME, notify: 'never' })).join(' ')).toContain('runs as the person who made it');
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

describe('letting its runs go ahead without asking', () => {
  const NAME = 'schedule/orders_report';
  const APPROVED = { approved: { by: TEST_USER.id, preview: { title: 'Schedule it', parts: [], irreversible: false } } };
  /** A run of a fn as an agent calls it for the person (not the person themselves). */
  const asAgent = (kit: Kit, fn: string) => ({ run: kit.hub.runInfo(QualifiedName.parse(`schedule/${fn}`), { user: NEW_YORK, caller: 'act_agent', time: { now: MON_8, timeZone: NEW_YORK.timeZone, local: '' } }) });
  const preview = async (s: Served, args: Json) => s.kit.hub.peer().call('preview', { run: 'run_preview', fn: 'add', args, user: NEW_YORK });

  it('the add card says what it runs, as whom, when, its next runs, args and notices, and offers the choice', async () => {
    const s = await served();
    const answer = await preview(s, { fn: TARGET, when: MONDAYS, args: { day: 'latest', limit: 5 }, notify: 'failed' });
    expect(answer).toMatchObject({ preview: { title: 'Schedule demo/orders_report: Every week on Monday at 9:00 am', irreversible: false }, ask: { into: 'allowRuns', label: 'Let its runs go ahead without asking' } });
    const text = JSON.stringify(answer);
    expect(text).toContain(`as **${NEW_YORK.name}**`);
    expect(text).toContain('Next runs: Mon, Nov 23 9:00 am; Mon, Nov 30 9:00 am; Mon, Dec 7 9:00 am.');
    expect(text).toContain('\\"limit\\": 5');
    expect(text).toContain('You are notified only when a run fails.');
    // the caller can't make the choice for the person; with the admin's "refuse" it isn't offered
    expect(await preview(s, { fn: TARGET, when: MONDAYS, allowRuns: true })).toEqual({ refused: 'allowRuns is the person\'s own choice, made on the approval card: leave it out.' });
    const refusing = await served({ config: { approvals: 'refuse' } });
    const plain = await preview(refusing, { fn: TARGET, when: MONDAYS, compute: 'day: the run\'s day' });
    expect(plain).not.toHaveProperty('ask');
    expect(JSON.stringify(plain)).toContain('one that needs your approval is refused (an admin set it so)');
  });

  it('records the choice made on the card on the schedule and as the hub\'s policy; a caller\'s own is refused', async () => {
    const s = await served();
    const args = { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 }, allowRuns: true };
    const byAgent = await s.kit.run('add', args, asAgent(s.kit, 'add'));
    expect(JSON.stringify(byAgent.outcome)).toContain('"path":"allowRuns"');
    expect(s.kit.hub.fns.kept.size).toBe(0);
    const ticked = await s.kit.run('add', args, { ...asAgent(s.kit, 'add'), ...APPROVED });
    expect(ticked.outcome).toMatchObject({ status: 'done', result: { schedule: NAME, runsAllowed: true } });
    expect(keptPayload(s, NAME).runsAllowed).toEqual({ at: MON_8, by: TEST_USER.id });
    expect(s.allowed).toEqual([{ fn: NAME, allow: true }]);
    // not ticked: nothing recorded
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, { ...asAgent(s.kit, 'add'), ...APPROVED });
    expect(keptPayload(s, `${NAME}_2`).runsAllowed).toBeUndefined();
    expect(s.allowed).toHaveLength(1);
  });

  it('is changed only by the person on its page, a new version each way; removing it takes the allowance away first', async () => {
    const s = await served();
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    expect(JSON.stringify((await s.kit.run('allow_runs', { schedule: NAME, allow: true }, asAgent(s.kit, 'allow_runs'))).outcome)).toContain('the person\'s own choice, made on its page');
    const on = await s.kit.run('allow_runs', { schedule: NAME, allow: true }, asPerson(s.kit, 'allow_runs'));
    expect(on.outcome).toMatchObject({ status: 'done', result: { runsAllowed: true }, undo: { schedule: NAME, version: 1 } });
    expect(keptPayload(s, NAME).runsAllowed).toMatchObject({ by: TEST_USER.id });
    const off = await s.kit.run('allow_runs', { schedule: NAME, allow: false }, asPerson(s.kit, 'allow_runs'));
    expect(off.outcome).toMatchObject({ status: 'done', undo: { schedule: NAME, version: 2 } });
    expect(keptPayload(s, NAME).runsAllowed).toBeUndefined();
    await s.kit.call('allow_runs', { schedule: NAME, allow: true }, asPerson(s.kit, 'allow_runs'));
    await s.kit.call('remove', { schedule: NAME }, asPerson(s.kit, 'remove'));
    expect(s.allowed).toEqual([{ fn: NAME, allow: true }, { fn: NAME, allow: false }, { fn: NAME, allow: true }, { fn: NAME, allow: false }]);
    expect(s.removed).toEqual([NAME]);
  });

  it('can\'t be turned on while the admin has firings that need approval refused', async () => {
    const s = await served({ config: { approvals: 'refuse' } });
    await s.kit.call('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 } }, asPerson(s.kit, 'add'));
    expect(JSON.stringify((await s.kit.run('allow_runs', { schedule: NAME, allow: true }, asPerson(s.kit, 'allow_runs'))).outcome)).toContain('An admin set scheduled runs that need approval to be refused');
    expect(JSON.stringify((await s.kit.run('add', { fn: TARGET, when: MONDAYS, args: { day: 'x', limit: 1 }, allowRuns: true }, { ...asPerson(s.kit, 'add'), ...APPROVED })).outcome)).toContain('An admin set');
    expect(s.allowed).toEqual([]);
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
