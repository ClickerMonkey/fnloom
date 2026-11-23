/**
 * Runs a system starts by itself as the owners of its kinds' fns, and its notices (`owner-runs.ts`): only its own
 * kinds' saved fns, the same key is the same run (doubled at once or later), a start is refused for an owner who is
 * gone or a system that isn't live, notices reach the owner (or the run's person) only and link only to their runs or
 * the system's own declared pages, a key is kept per system, and a run that notified is marked up its tree.
 */
import {
  ActorId, ItemSection, LinkSession, NotificationId, SessionId, KindDecl, noFnStats, QualifiedName, RunId, SystemName, TurnId, type FnDecl, type FnRecord, type KindRecord, type ResolvedLimits,
} from '@harness/core';
import { reject } from '@ayepi/core';
import { describe, expect, it } from 'vitest';
import type { NotificationInput } from '../chat/index.ts';
import { FakeRuns, makeRun } from '../chat/testing.ts';
import { manifestFor, systemRow } from '../catalog/fixtures.ts';
import { system } from '@harness/sdk';
import { RecordingBus, memoryLog, testStore } from '../testing.ts';
import { OwnerRuns, STARTED_KEY } from './owner-runs.ts';

const SCHEDULE = SystemName.parse('timer');
const OTHER = SystemName.parse('other');
const ADA = ActorId.parse('act_ada');
const BEN = ActorId.parse('act_ben');
const link = LinkSession.parse({ system: SCHEDULE, instance: 'main', boot: 'b1' });
const q = (name: string) => QualifiedName.parse(name);

/** A fn of a kind as `hub/fns_save` keeps it: a person's saved fn. */
function savedFn(name: string, kind: string, payload: FnDecl['payload'], origin: FnRecord['origin'] = 'runtime'): FnRecord {
  const qualified = q(name);
  return {
    name: qualified, system: SystemName.parse(qualified.split('/')[0] ?? ''), version: 'h1', origin, available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 100,
    decl: {
      name: qualified.split('/')[1] ?? '', description: 'A saved fn.', kind: q(kind), payload, args: { name: 'any' }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [],
    },
  };
}

const kindRecord = (name: string, system: SystemName): KindRecord => ({
  name: q(name), system, decl: KindDecl.parse({ name: name.split('/')[1], description: 'k', applicability: 'k', payload: { name: 'any' }, approveChanges: false }),
});

const LIMITS: ResolvedLimits = { priority: 'background', priorityFrom: { default: 'hub' }, turn: { cost: 5, time: 60_000 }, budgets: [] };

async function world() {
  const store = await testStore();
  const bus = new RecordingBus();
  let n = 0;
  const runs = new FakeRuns(store, () => RunId.parse(`run_${String(++n)}`));
  const fns = new Map<string, FnRecord>();
  const kinds = new Map<string, KindRecord>([['timer/plan', kindRecord('timer/plan', SCHEDULE)], ['other/note', kindRecord('other/note', OTHER)]]);
  const owners = new Map<string, ActorId>();
  const notices: NotificationInput[] = [];
  const asked: Array<{ requested: string | undefined }> = [];
  for (const [id, name] of [[ADA, 'Ada'], [BEN, 'Ben']] as const) {
    await store.table('actors').insert({ id, kind: 'user', name, about: '', email: `${name.toLowerCase()}@example.com`, role: 'member', createdAt: 1, disabled: false });
  }
  await store.table('systems').put(systemRow(SCHEDULE, 'connected', { stage: 'live' }));
  // the system declares one page, `item`
  const contract = system('timer', { description: 'Timers.', pages: [{ segment: 'item', title: 'Item', nav: 'hidden', component: 'ItemPage' }] });
  await store.table('manifests').put({ system: SCHEDULE, manifest: await manifestFor(contract), importedAt: 1 });
  const owner = new OwnerRuns({
    store: () => store,
    catalog: () => ({ fn: (name) => Promise.resolve(fns.get(name)), kind: (name) => Promise.resolve(kinds.get(name)) }),
    runs: () => runs,
    limits: () => ({ resolve: (input) => { asked.push({ requested: input.requested }); return Promise.resolve(LIMITS); } }),
    notifications: () => ({ notify: (input) => { notices.push(input); return Promise.resolve({ id: NotificationId.parse(`ntf_${String(notices.length)}`), ...input, read: false, pushed: false, createdAt: 1 }); } }),
    sharing: () => ({ sharing: (target) => Promise.resolve({ owner: owners.get('fn' in target ? target.fn : '') ?? ADA, visibility: 'private' as const, with: [] }) }),
    bus: () => bus,
    clock: () => 1_000,
    log: memoryLog().log,
  });
  const save = async (fn: FnRecord, by: ActorId = ADA): Promise<void> => {
    fns.set(fn.name, fn);
    owners.set(fn.name, by);
    await store.table('fnLinks').put({ fn: fn.name, to: QualifiedName.parse(fn.decl.kind), link: 'kind', system: fn.system });
    await store.table('itemVersions').put({ id: `${fn.system}:fns:${fn.name}:1`, system: fn.system, section: ItemSection.parse('fns'), name: fn.name, number: 1, change: 'added', decl: { kind: fn.decl.kind }, hash: 'h', savedAt: 1 });
  };
  return { store, bus, runs, fns, notices, owner, save, asked, owners };
}

describe('kindFns', () => {
  it('lists the saved fns of its own kind with owner, title, version and payload, and refuses another system’s kind', async () => {
    const w = await world();
    await w.save(savedFn('timer/weekly_sales_summary', 'timer/plan', { every: 'monday' }));
    await w.save(savedFn('timer/built_in', 'timer/plan', {}, 'contract'));
    const page = await w.owner.kindFns(link, { kind: q('timer/plan') });
    expect(page.items).toEqual([{
      fn: 'timer/weekly_sales_summary', kind: 'timer/plan', owner: ADA, title: 'Weekly sales summary', version: 1, payload: { every: 'monday' }, removed: false, updatedAt: 100,
    }]);
    expect((await w.owner.kindFns(link, { kind: q('timer/plan'), changedSince: 200 })).items).toEqual([]);
    await expect(w.owner.kindFns(link, { kind: q('other/note') })).rejects.toMatchObject({ status: 403 });
  });
});

describe('start', () => {
  it('starts a run of the fn as its owner in a sessionless turn of theirs, with the system as caller, at background priority under the cap', async () => {
    const w = await world();
    await w.save(savedFn('timer/weekly', 'timer/plan', {}));
    const started = await w.owner.start(link, { fn: q('timer/weekly'), args: { at: 5 }, key: 'weekly@5', maxSpend: 0.5 });
    expect(w.runs.started).toMatchObject([{ fn: 'timer/weekly', args: { at: 5 }, actor: ADA, caller: 'act_timer', key: `${STARTED_KEY}timer:weekly@5`, priority: 'background' }]);
    expect(w.runs.started[0]?.session).toBeUndefined();
    expect(w.asked).toEqual([{ requested: 'background' }]);
    const turn = await w.store.table('turns').get(started.turn);
    expect(turn).toMatchObject({ actor: ADA, root: started.run, limits: { turn: { cost: 0.5 } }, status: 'running' });
    // the turn ends with its run
    await w.store.table('runs').update(started.run, { status: 'done' });
    w.runs.finish(started.run, { status: 'done', result: {} });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect((await w.store.table('turns').get(started.turn))?.status).toBe('done');
  });

  it('is idempotent per key: a doubled start at once, and one later, give the first run', async () => {
    const w = await world();
    await w.save(savedFn('timer/weekly', 'timer/plan', {}));
    const input = { fn: q('timer/weekly'), args: {}, key: 'weekly@5' };
    const [a, b] = await Promise.all([w.owner.start(link, input), w.owner.start(link, input)]);
    expect(b.run).toBe(a.run);
    expect(await w.owner.start(link, input)).toMatchObject({ run: a.run, turn: a.turn });
    expect(w.runs.started).toHaveLength(1);
    // another key is another run
    await w.owner.start(link, { ...input, key: 'weekly@6' });
    expect(w.runs.started).toHaveLength(2);
  });

  it('refuses another system’s kind, a fn that isn’t saved, a system that isn’t live, and an owner who is gone', async () => {
    const w = await world();
    await w.save(savedFn('other/note_1', 'other/note', {}));
    await w.save(savedFn('timer/weekly', 'timer/plan', {}));
    await expect(w.owner.start(link, { fn: q('other/note_1'), args: {}, key: 'k' })).rejects.toMatchObject({ status: 403 });
    await expect(w.owner.start(link, { fn: q('timer/nope'), args: {}, key: 'k' })).rejects.toMatchObject({ status: 404 });
    await w.store.table('actors').update(ADA, { disabled: true });
    await expect(w.owner.start(link, { fn: q('timer/weekly'), args: {}, key: 'k' })).rejects.toMatchObject({ status: 409 });
    await w.store.table('actors').update(ADA, { disabled: false });
    await w.store.table('systems').put(systemRow(SCHEDULE, 'connected', { stage: 'installed' }));
    await expect(w.owner.start(link, { fn: q('timer/weekly'), args: {}, key: 'k' })).rejects.toMatchObject({ status: 409 });
    expect(w.runs.started).toHaveLength(0);
  });

  it('turns a refusal of the run (a policy, an unknown fn) into a refused start and ends the turn', async () => {
    const w = await world();
    await w.save(savedFn('timer/weekly', 'timer/plan', {}));
    w.runs.refuseStart = reject(403, 'DENIED', 'Not allowed: no');
    await expect(w.owner.start(link, { fn: q('timer/weekly'), args: {}, key: 'k' })).rejects.toMatchObject({ status: 409 });
    const turns = await w.store.table('turns').find({ limit: 5 });
    expect(turns.items.map((t) => t.status)).toEqual(['failed']);
  });
});

describe('notices', () => {
  it('reach the fn’s owner only, with a run of theirs or the system’s own page, the body clamped and the key kept per system', async () => {
    const w = await world();
    await w.save(savedFn('timer/weekly', 'timer/plan', {}), BEN);
    await w.store.table('turns').insert({ id: TurnId.parse('trn_1'), actor: BEN, user: { id: BEN, name: 'Ben', email: '', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' }, time: { now: 1, timeZone: 'UTC', local: 'x' }, status: 'done', limits: LIMITS, cost: 0, errors: { max: 1 }, createdAt: 1 });
    await w.store.table('runs').insert(makeRun({ id: RunId.parse('run_ben'), fn: q('timer/weekly'), turn: TurnId.parse('trn_1'), actor: BEN }));
    await w.owner.notifyOwner(link, q('timer/weekly'), {
      title: 'Weekly ran', body: 'word '.repeat(60), tone: 'ok', key: 'weekly',
      link: { run: RunId.parse('run_ben') }, also: { label: 'History', link: { page: { system: SCHEDULE, segment: 'item', path: ['weekly'], query: { tab: 'history' } } } },
    });
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toMatchObject({ user: BEN, reason: 'system-message', tone: 'ok', key: 'timer:weekly', link: { run: 'run_ben' }, also: { label: 'History' } });
    expect(w.notices[0]?.body.length).toBeLessThanOrEqual(160);
    // no link: the system's own page
    await w.owner.notifyOwner(link, q('timer/weekly'), { title: 't', body: 'b' });
    expect(w.notices[1]?.link).toEqual({ system: SCHEDULE });
    // a run of someone else's, another system's page, an undeclared page, another system's fn: refused, nothing sent
    await w.store.table('runs').insert(makeRun({ id: RunId.parse('run_ada'), fn: q('timer/weekly'), turn: TurnId.parse('trn_none'), actor: ADA }));
    await expect(w.owner.notifyOwner(link, q('timer/weekly'), { title: 't', body: 'b', link: { run: RunId.parse('run_ada') } })).rejects.toMatchObject({ status: 403 });
    await expect(w.owner.notifyOwner(link, q('timer/weekly'), { title: 't', body: 'b', link: { page: { system: OTHER, segment: 'item' } } })).rejects.toMatchObject({ status: 403 });
    await expect(w.owner.notifyOwner(link, q('timer/weekly'), { title: 't', body: 'b', link: { page: { system: SCHEDULE, segment: 'month' } } })).rejects.toMatchObject({ status: 422 });
    await expect(w.owner.notifyOwner(link, q('timer/weekly'), { title: 't', body: 'b', link: { session: SessionId.parse('ses_1') } })).rejects.toMatchObject({ status: 422 });
    expect(w.notices).toHaveLength(2);
  });

  it('from a run, reach its person, link to the run by default, and mark it and the runs above it as having notified', async () => {
    const w = await world();
    await w.store.table('turns').insert({ id: TurnId.parse('trn_1'), actor: ADA, user: { id: ADA, name: 'Ada', email: '', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' }, time: { now: 1, timeZone: 'UTC', local: 'x' }, status: 'running', limits: LIMITS, cost: 0, errors: { max: 1 }, createdAt: 1 });
    await w.store.table('runs').insert(makeRun({ id: RunId.parse('run_top'), fn: q('timer/weekly'), turn: TurnId.parse('trn_1'), actor: ADA, status: 'running' }));
    await w.store.table('runs').insert(makeRun({ id: RunId.parse('run_child'), fn: q('timer/remind'), turn: TurnId.parse('trn_1'), actor: ADA, parent: RunId.parse('run_top'), root: RunId.parse('run_top'), status: 'running' }));
    await w.owner.notify(link, RunId.parse('run_child'), { title: 'Reminder', body: 'Take the bins out.' });
    expect(w.notices[0]).toMatchObject({ user: ADA, link: { run: 'run_child' } });
    expect(w.bus.of('run.notified')).toEqual([{ runs: ['run_child', 'run_top'] }]);
    // another system's run, or one that settled, is refused
    await expect(w.owner.notify({ ...link, system: OTHER }, RunId.parse('run_child'), { title: 't', body: 'b' })).rejects.toMatchObject({ status: 403 });
    await w.store.table('runs').update(RunId.parse('run_top'), { status: 'done' });
    await expect(w.owner.notify(link, RunId.parse('run_top'), { title: 't', body: 'b' })).rejects.toMatchObject({ status: 403 });
  });
});
