import { fn, g, handler, system } from '@harness/sdk';
import { ApprovalId, RunId, type Json, type QualifiedName, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { RunRefused } from './errors.ts';
import type { RunInput } from './index.ts';
import { mergeProgress, settledOf } from './runs.ts';
import { AGENT, ALICE, executionRig, settle, until, type ExecutionRig } from './testing.ts';

const read = fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] });
const write = fn({
  description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool(), undo: g.obj({ path: g.text() }), resume: g.obj({ at: g.num() }),
});
const confirmable = fn({
  description: 'Delete, asking first.', args: g.obj({ path: g.text() }), returns: g.bool(), tags: ['read'],
  handlers: { confirm: handler({ description: 'Sure?', args: g.obj({ path: g.text() }), returns: g.bool(), required: true }) },
});

const files = system('fs', { description: 'Files.' }).with({ fns: { read, write, remove: confirmable } });
const copy = fn({ description: 'Copy.', args: g.obj({ from: g.text() }), returns: g.text(), tags: ['read'], deps: { read: files.fns.read } });
const flaky = fn({ description: 'Flaky.', args: g.obj({}), returns: g.text(), tags: ['read'], limits: { retries: 1 } });
const shaky = system('fs', { description: 'Files.' }).with({ fns: { flaky } });
const retrying = fn({ description: 'Calls flaky.', args: g.obj({}), returns: g.text(), tags: ['read'], deps: { flaky: shaky.fns.flaky } });
const sweep = fn({ description: 'Sweep.', args: g.obj({}), returns: g.text(), tags: ['read'], deps: { remove: files.fns.remove } });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(): Promise<ExecutionRig> {
  rig = executionRig();
  rig.catalog.add('fs', 'read', read);
  rig.catalog.add('fs', 'write', write);
  rig.catalog.add('fs', 'remove', confirmable);
  rig.catalog.add('fs', 'copy', copy);
  rig.catalog.add('fs', 'sweep', sweep);
  await rig.module.start();
  return rig;
}

const input = (turn: Turn, fnName: QualifiedName, args: Json): RunInput => ({
  fn: fnName, args, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
});
const NO_APPROVAL = ApprovalId.parse('apr_none');

describe('runs on a system', () => {
  it('runs a read fn on its system, records it and settles once', async () => {
    const r = await started();
    const fs = r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'a.txt' }));
    expect(await settled).toEqual({ status: 'done', result: { echo: { path: 'a.txt' } } });
    const row = await r.module.runs.get(run);
    expect(row).toMatchObject({ status: 'done', system: 'fs', root: run, fn: 'fs/read', attempt: 1 });
    expect(fs.requests[0]).toMatchObject({ fn: 'read', kind: 'native', args: { path: 'a.txt' }, run: { user: { id: ALICE }, caller: ALICE } });
    expect(fs.requests[0]?.run.time.local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const statuses = r.bus.of('run.update').filter((u) => u.run === run).map((u) => (u.update.type === 'status' ? u.update.status : u.update.type));
    expect(statuses).toEqual(['queued', 'running', 'done']);
  });

  it('refuses unknown fns, bad args and calls outside the deps', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    await expect(r.module.runs.start(input(turn, 'fs/nope', {}))).rejects.toBeInstanceOf(RunRefused);
    await expect(r.module.runs.start(input(turn, 'fs/read', { path: 3 }))).rejects.toMatchObject({ error: { code: 'bad-args', class: 'caller' } });
    const parent = await r.module.runs.start(input(turn, 'fs/copy', { from: 'x' }));
    await parent.settled;
    await expect(r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), parent: parent.run })).rejects.toMatchObject({ error: { code: 'not-a-dep' } });
    await expect(r.module.runs.start({ ...input(turn, 'fs/read', { path: 'x' }), parent: RunId.parse('run_missing') })).rejects.toMatchObject({ error: { code: 'not-found' } });
  });

  it('gives a repeated call key the run it already has (resume by key)', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const parent = await r.module.runs.start(input(turn, 'fs/copy', { from: 'x' }));
    r.connect('fs').behaviour.run = () => new Promise(() => undefined);
    const first = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'x' }), parent: parent.run, key: 'read-1' });
    const again = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'x' }), parent: parent.run, key: 'read-1' });
    expect(again.run).toBe(first.run);
  });

  it('waits for approval when a fn is not tagged read, then runs once approved', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), caller: AGENT });
    expect((await r.module.runs.get(run))?.status).toBe('awaiting-approval');
    const approval = r.bus.of('approval')[0]?.approval;
    expect(approval?.status).toBe('pending');
    expect(r.bus.of('approval')[0]?.approvers).toEqual([ALICE]);
    await r.module.policies.answer(approval?.id ?? NO_APPROVAL, { by: ALICE, approve: true, remember: 'once' });
    expect(await settled).toMatchObject({ status: 'done' });
  });

  it('fails a run the person refuses', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const { settled } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), caller: AGENT });
    await settle();
    const approval = r.bus.of('approval')[0]?.approval;
    await r.module.policies.answer(approval?.id ?? NO_APPROVAL, { by: ALICE, approve: false, remember: 'once', reason: 'no' });
    expect(await settled).toMatchObject({ status: 'failed', error: { code: 'denied', message: 'The person refused this: no' } });
  });

  it('runs a fn the person runs themselves without asking', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'fs/write', { path: 'a', text: 'b' }));
    expect(await settled).toMatchObject({ status: 'done' });
  });

  it('retries a failure classed retry up to the fn limit, recording each error', async () => {
    const r = await started();
    r.catalog.add('fs', 'flaky', flaky);
    const fs = r.connect('fs');
    let tries = 0;
    fs.behaviour.run = () => Promise.resolve(++tries === 1 ? { status: 'failed', error: { class: 'retry', message: 'busy' } } : { status: 'done', result: 'ok' });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/flaky', {}));
    expect(await settled).toEqual({ status: 'done', result: 'ok' });
    expect(await r.module.runs.get(run)).toMatchObject({ attempt: 2, errors: [{ attempt: 1, error: { message: 'busy' } }] });
  });

  it('keeps a run queued while its system is away and sends it again on reconnect', async () => {
    const r = await started();
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'x' }));
    await until(async () => (await r.module.runs.get(run))?.status === 'queued' && r.records.some((rec) => rec.msg === 'run.system-gone'), 'the run to wait');
    r.connect('fs');
    await r.module.runs.resend('fs');
    expect(await settled).toMatchObject({ status: 'done' });
  });

  it('sends a system its waiting runs as a restart as soon as it is connected again', async () => {
    const r = await started();
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'x' }));
    await until(async () => (await r.module.runs.get(run))?.status === 'queued' && r.records.some((rec) => rec.msg === 'run.system-gone'), 'the run to wait');
    const fs = r.connect('fs');
    r.bus.publish('system.status', { system: fs.name, status: 'connected' });
    expect(await settled).toMatchObject({ status: 'done' });
    expect(fs.requests[0]?.resume).toEqual({ state: null, calls: {}, reason: 'restart' });
  });

  it('runs a run once when two queue jobs hand it over at the same moment', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let release: () => void = () => undefined;
    fs.behaviour.run = () => new Promise((resolve) => { release = () => { resolve({ status: 'done', result: 'ok' }); }; });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), caller: AGENT });
    const approval = r.bus.of('approval')[0]?.approval;
    // Queued by hand twice, as a resend after a restart can while the old job is still in the queue.
    await r.module.policies.answer(approval?.id ?? NO_APPROVAL, { by: ALICE, approve: true, remember: 'once' });
    const signal = new AbortController().signal;
    const twice = Promise.all([r.module.runs.execute({ run }, signal), r.module.runs.execute({ run }, signal)]);
    await until(() => fs.requests.length > 0, 'the run to reach the system');
    release();
    await twice;
    expect(await settled).toEqual({ status: 'done', result: 'ok' });
    expect(fs.requests).toHaveLength(1);
  });

  it('adds the cost of a failed attempt to the parent runs before retrying', async () => {
    const r = await started();
    r.catalog.add('fs', 'flaky', flaky);
    r.catalog.add('fs', 'retrying', retrying);
    const fs = r.connect('fs');
    let tries = 0;
    fs.behaviour.run = (request) => {
      if (request.fn === 'retrying') return new Promise(() => undefined);
      tries += 1;
      return Promise.resolve(tries === 1 ? { status: 'failed', error: { class: 'retry', message: 'busy' }, cost: 0.25 } : { status: 'done', result: 'ok', cost: 0.5 });
    };
    const turn = await r.turn();
    const parent = await r.module.runs.start(input(turn, 'fs/retrying', {}));
    const child = await r.module.runs.start({ ...input(turn, 'fs/flaky', {}), parent: parent.run, key: 'f' });
    await child.settled;
    expect(await r.module.runs.get(child.run)).toMatchObject({ cost: 0.75, totalCost: 0.75 });
    expect(await r.module.runs.get(parent.run)).toMatchObject({ cost: 0, totalCost: 0.75 });
  });

  it('will not pause a run that waits for approval, since resuming it would skip the approval', async () => {
    const r = await started();
    r.connect('fs');
    r.catalog.add('fs', 'pausable', fn({ description: 'Pausable.', args: g.obj({}), returns: g.text(), resume: g.obj({ at: g.num() }) }));
    const turn = await r.turn();
    const { run } = await r.module.runs.start({ ...input(turn, 'fs/pausable', {}), caller: AGENT });
    expect((await r.module.runs.get(run))?.status).toBe('awaiting-approval');
    expect(await r.module.runs.pause(run, ALICE)).toMatchObject({ accepted: false });
    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: true });
    expect((await r.module.runs.get(run))?.status).toBe('cancelled');
  });

  it('cancels a queued run at once, and asks the system to cancel a running one', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let release: (o: { status: 'cancelled' }) => void = () => undefined;
    fs.behaviour.run = () => new Promise((resolve) => { release = resolve; });
    fs.behaviour.control = (c) => { if (c.action === 'cancel') release({ status: 'cancelled' }); return { accepted: true }; };
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'x' }));
    await until(async () => (await r.module.runs.get(run))?.status === 'running', 'the run to start');
    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: true });
    expect(await settled).toEqual({ status: 'cancelled' });
    expect(await r.module.runs.cancel(run, ALICE)).toMatchObject({ accepted: false });
  });

  it('pauses a run with its resume state and resumes it with the finished child calls by key', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.run = (request) => Promise.resolve(request.resume === undefined ? { status: 'paused', resume: { at: 2 } } : { status: 'done', result: request.resume.state });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/write', { path: 'a', text: 'b' }));
    await until(async () => (await r.module.runs.get(run))?.status === 'paused', 'the pause');
    expect((await r.module.runs.get(run))?.resume).toEqual({ at: 2 });
    await r.module.runs.resume(run, ALICE);
    expect(await settled).toEqual({ status: 'done', result: { at: 2 } });
    expect(fs.requests[1]?.resume).toEqual({ state: { at: 2 }, calls: {}, reason: 'resumed' });
  });

  it('moves a run to the background so its caller stops waiting', async () => {
    const r = await started();
    r.connect('fs').behaviour.run = () => new Promise(() => undefined);
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'x' }));
    expect(await r.module.runs.background(run)).toBe(true);
    expect(await settled).toEqual({ status: 'background', run });
  });

  it('reports progress, narrows operations and undoes with the registered payload', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.run = () => Promise.resolve({ status: 'done', result: true, undo: { path: 'a' } });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/write', { path: 'a', text: 'b' }));
    await settled;
    await r.module.runs.progress(run, { fraction: 0.5 });
    expect((await r.module.runs.get(run))?.progress).toBeUndefined();
    const undo = await r.module.runs.undo(run, ALICE);
    expect(undo).toEqual({ status: 'undone', summary: 'put back' });
    expect((await r.module.runs.get(run))?.status).toBe('undone');
    expect(await r.module.runs.undo(run, ALICE)).toEqual({ status: 'gone' });
  });

  it('refuses a fn with a required handler from a caller that can not answer it', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const parent = await r.module.runs.start(input(turn, 'fs/sweep', {}));
    await expect(r.module.runs.start({ ...input(turn, 'fs/remove', { path: 'x' }), parent: parent.run })).rejects.toMatchObject({ error: { code: 'needs-handlers' } });
    const supplied = await r.module.runs.start({ ...input(turn, 'fs/remove', { path: 'x' }), parent: parent.run, key: 'r2', handlers: ['confirm'] });
    expect(r.module.runs.handlersOf(supplied.run)).toEqual(['confirm']);
  });
});

describe('progress and settled shapes', () => {
  it('merges step reports and replaces fractions', () => {
    const steps = mergeProgress(mergeProgress(undefined, { step: 'a', status: 'done' }), { step: 'b', status: 'active', detail: 'half' });
    expect(steps).toEqual({ steps: { a: { status: 'done' }, b: { status: 'active', detail: 'half' } } });
    expect(mergeProgress(steps, { fraction: 0.3 })).toEqual({ fraction: 0.3 });
  });

  it('hears every outcome the way a caller does', () => {
    const run = RunId.parse('run_1');
    expect(settledOf({ status: 'done', result: 1 }, run)).toEqual({ status: 'done', result: 1 });
    expect(settledOf({ status: 'paused', resume: null }, run)).toEqual({ status: 'background', run });
    expect(settledOf(undefined, run)).toEqual({ status: 'background', run });
  });
});
