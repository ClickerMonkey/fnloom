import { fn, g, hub } from '@harness/sdk';
import { RunId, type FnRecord, type Json, type QualifiedName, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DeadlineTimers, deadlineError, runDeadline } from './deadlines.ts';
import type { RunInput } from './index.ts';
import { ALICE, OPEN_LIMITS, TestCatalog, executionRig, type ExecutionRig } from './testing.ts';

const quick = fn({ description: 'Read, quickly.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'], limits: { timeout: 60 } });
const slow = fn({ description: 'Read, slowly.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(): Promise<ExecutionRig> {
  rig = await executionRig();
  rig.catalog.add('fs', 'quick', quick);
  rig.catalog.add('fs', 'slow', slow);
  await rig.module.start();
  return rig;
}

const input = (turn: Turn, fnName: QualifiedName, args: Json): RunInput => ({
  fn: fnName, args, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
});

/** A fn record whose only limit is the given timeout (or none). */
function withTimeout(timeout?: number): FnRecord {
  const record = new TestCatalog().add('fs', 'slow', slow);
  return { ...record, decl: { ...record.decl, limits: timeout === undefined ? {} : { timeout } } };
}

describe('run deadlines', () => {
  it('ends a run at its fn timeout when that comes before the turn runs out of time, else at the turn', async () => {
    rig = await executionRig();
    const turn = { createdAt: 1_000, limits: { ...OPEN_LIMITS, turn: { cost: 1, time: 10_000 } } };
    expect(runDeadline(2_000, turn, withTimeout(500))).toEqual({ at: 2_500, by: 'fn' });
    expect(runDeadline(2_000, turn, withTimeout(20_000))).toEqual({ at: 11_000, by: 'turn' });
    expect(runDeadline(2_000, turn, withTimeout())).toEqual({ at: 11_000, by: 'turn' });
    // a turn a person continued gets its time budget again from then, so an old stopped turn doesn't time out at once
    expect(runDeadline(50_000, { ...turn, continuedAt: 50_000 }, withTimeout())).toEqual({ at: 60_000, by: 'turn' });
    expect(deadlineError({ at: 0, by: 'fn' }, { fn: 'fs/slow' }, turn, withTimeout(500))).toEqual({ class: 'retry', message: 'fs/slow took longer than its 500 ms limit and was stopped.', code: 'timeout' });
    expect(deadlineError({ at: 0, by: 'turn' }, { fn: 'fs/slow' }, turn, withTimeout())).toMatchObject({ class: 'fatal', code: 'timeout' });
  });

  it('tells a system the earlier of the turn deadline and the fn timeout, and the turn time left', async () => {
    const r = await started();
    const system = r.connect('fs');
    const turn = await r.turn({ limits: { ...OPEN_LIMITS, turn: { cost: 1, time: 30_000 } } });
    r.time.now += 1_000;
    await (await r.module.runs.start(input(turn, 'fs/slow', { path: 'a' }))).settled;
    expect(system.requests[0]).toMatchObject({ deadline: turn.createdAt + 30_000, budget: { time: 29_000 } });
    await (await r.module.runs.start({ ...input(turn, 'fs/quick', { path: 'b' }), key: 'quick' })).settled;
    expect(system.requests[1]).toMatchObject({ deadline: r.time.now + 60, budget: { time: 29_000 } });
  });

  it('stops a system run that runs past its fn timeout, tells the system to cancel, and settles it as a timeout', async () => {
    const r = await started();
    const system = r.connect('fs');
    const controls: string[] = [];
    system.behaviour.run = () => new Promise(() => undefined);
    system.behaviour.control = (c) => { controls.push(c.action); return { accepted: true }; };
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/quick', { path: 'a' }));
    expect(await settled).toEqual({ status: 'failed', error: { class: 'retry', message: 'fs/quick took longer than its 60 ms limit and was stopped.', code: 'timeout' } });
    expect(controls).toEqual(['cancel']);
    expect(await r.module.runs.get(run)).toMatchObject({ status: 'failed', attempt: 1 });
    expect(r.records.some((record) => record.msg === 'run.timed-out')).toBe(true);
  });

  it('stops a run when its turn runs out of time, even with no fn timeout', async () => {
    const r = await started();
    r.connect('fs').behaviour.run = () => new Promise(() => undefined);
    const turn = await r.turn({ limits: { ...OPEN_LIMITS, turn: { cost: 1, time: 50 } } });
    const { settled } = await r.module.runs.start(input(turn, 'fs/slow', { path: 'a' }));
    expect(await settled).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'timeout' } });
  });

  it('fails a run at once when its turn is already out of time', async () => {
    const r = await started();
    const system = r.connect('fs');
    const turn = await r.turn({ limits: { ...OPEN_LIMITS, turn: { cost: 1, time: 1_000 } } });
    r.time.now += 5_000;
    const { settled } = await r.module.runs.start(input(turn, 'fs/slow', { path: 'a' }));
    expect(await settled).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'timeout' } });
    expect(system.requests).toEqual([]);
  });

  it('stops a hub fn that ignores its signal', async () => {
    const r = await started();
    r.catalog.add('hub', 'run_status', fn({ description: 'Status.', args: hub.fns.run_status.args, returns: hub.fns.run_status.returns, tags: ['read'], limits: { timeout: 40 } }));
    let seen: AbortSignal | undefined;
    r.module.hubFns.register(hub.fns.run_status, (_args, ctx) => { seen = ctx.signal; return new Promise(() => undefined); });
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'hub/run_status', { run: 'run_x' }));
    expect(await settled).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    expect(seen?.aborted).toBe(true);
  });

  it('leaves a run that finishes in time alone', async () => {
    const r = await started();
    const system = r.connect('fs');
    system.behaviour.run = () => new Promise((resolve) => { setTimeout(() => { resolve({ status: 'done', result: 'ok' }); }, 10); });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/quick', { path: 'a' }));
    expect(await settled).toEqual({ status: 'done', result: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await r.module.runs.get(run)).toMatchObject({ status: 'done' });
    expect(r.records.some((record) => record.msg === 'run.timed-out')).toBe(false);
  });
});

const [RUN_A, RUN_B, RUN_C] = [RunId.parse('run_a'), RunId.parse('run_b'), RunId.parse('run_c')];

describe('deadline timers', () => {
  it('fires at the deadline, at once when it has passed, and not after being disarmed', async () => {
    const now = { at: 1_000 };
    const timers = new DeadlineTimers(() => now.at);
    const fired: string[] = [];
    timers.arm(RUN_A, 1_020, () => fired.push('a'));
    timers.arm(RUN_B, 900, () => fired.push('b'));
    timers.arm(RUN_C, 1_010, () => fired.push('c'));
    expect(timers.armed(RUN_C)).toBe(true);
    timers.disarm(RUN_C);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toEqual(['b', 'a']);
    expect(timers.armed(RUN_A)).toBe(false);
  });
});
