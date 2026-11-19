import { fn, g, handler, hub, system } from '@harness/sdk';
import { ApprovalId, InstanceName, INVALID_INPUT_CODE, PolicyId, RunId, SystemName, type InvalidInput, type Json, type QualifiedName, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { RunRefused } from './errors.ts';
import type { RunInput } from './index.ts';
import { invalidArgs, mergeProgress, settledOf } from './runs.ts';
import { z } from 'zod';
import { AGENT, ALICE, executionRig, settle, until, type ExecutionRig } from './testing.ts';
import { systemRow } from '../catalog/fixtures.ts';

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
const worded = fn({
  description: 'Reads, worded.', args: g.obj({ path: g.text() }), returns: g.obj({ lines: g.num() }), tags: ['read'], limits: { retries: 1 },
  status: {
    active: { one: 'Reading {args.path}…', many: 'Reading {n} files…' },
    retry: { one: 'Retrying {args.path}…', many: 'Retrying {n} reads…' },
    done: { one: 'Read {args.path} ({output.lines} lines)', many: 'Read {n} files' },
    failed: { one: 'Reading {args.path} failed', many: '{n} reads failed' },
  },
});
const copying = system('fs', { description: 'Files.' }).with({ fns: { copy } });
const outer = fn({ description: 'Copies.', args: g.obj({}), returns: g.text(), tags: ['read'], deps: { copy: copying.fns.copy } });
const sweep = fn({ description: 'Sweep.', args: g.obj({}), returns: g.text(), tags: ['read'], deps: { remove: files.fns.remove } });

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

async function started(options: Parameters<typeof executionRig>[0] = {}): Promise<ExecutionRig> {
  rig = await executionRig(options);
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

  it('words every status change from the fn’s status templates, keeping the words on the run', async () => {
    const r = await started();
    r.catalog.add('fs', 'flaky', worded);
    const fs = r.connect('fs');
    let tries = 0;
    fs.behaviour.run = () => Promise.resolve(++tries === 1 ? { status: 'failed', error: { class: 'retry', message: 'busy' } } : { status: 'done', result: { lines: 3 } });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/flaky', { path: 'a.md' }));
    await settled;
    const words = r.bus.of('run.update').filter((u) => u.run === run).flatMap((u) => (u.update.type === 'status' ? [`${u.update.status}: ${u.update.text?.one ?? '-'}`] : []));
    expect(words).toEqual(['queued: Reading a.md…', 'running: Reading a.md…', 'queued: Retrying a.md…', 'running: Retrying a.md…', 'done: Read a.md (3 lines)']);
    expect((await r.module.runs.get(run))?.text).toEqual({ phase: 'done', one: 'Read a.md (3 lines)', many: 'Read {n} files' });
  });

  it('words a fn without templates with the hub’s defaults, and leaves approval to the chat', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const { run } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a.md', text: 'x' }), caller: AGENT });
    const updates = r.bus.of('run.update').filter((u) => u.run === run).flatMap((u) => (u.update.type === 'status' ? [u.update] : []));
    expect(updates).toEqual([
      { type: 'status', status: 'queued', text: { phase: 'active', one: 'Write…', many: 'Write ×{n}…' } },
      { type: 'status', status: 'awaiting-approval' },
    ]);
  });

  it('refuses unknown fns and calls outside the deps', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    await expect(r.module.runs.start(input(turn, 'fs/nope', {}))).rejects.toBeInstanceOf(RunRefused);
    const parent = await r.module.runs.start(input(turn, 'fs/copy', { from: 'x' }));
    await parent.settled;
    await expect(r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), parent: parent.run })).rejects.toMatchObject({ error: { code: 'not-a-dep' } });
    await expect(r.module.runs.start({ ...input(turn, 'fs/read', { path: 'x' }), parent: RunId.parse('run_missing') })).rejects.toMatchObject({ error: { code: 'not-found' } });
  });

  it('lets the hub’s own fns call fns no declaration names (their calls are the hub’s code)', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    r.catalog.add('hub', 'run_wait', fn({ description: 'Wait.', args: hub.fns.run_wait.args, returns: hub.fns.run_wait.returns, tags: ['read'], resume: g.obj({}) }));
    const waited = await r.module.runs.start(input(turn, 'fs/copy', { from: 'x' }));
    const parent = await r.module.runs.start({ ...input(turn, 'hub/run_wait', { run: waited.run, timeout: 60_000 }), key: 'wait' });
    const child = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'x' }), parent: parent.run, key: 'child' });
    expect((await r.module.runs.get(child.run))?.parent).toBe(parent.run);
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

  it('notes when a person approved, apart from when it was made', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), caller: AGENT });
    r.time.now += 5_000;
    const approval = r.bus.of('approval')[0]?.approval;
    await r.module.policies.answer(approval?.id ?? NO_APPROVAL, { by: ALICE, approve: true, remember: 'once' });
    await settled;
    const row = await r.module.runs.get(run);
    expect(row?.approvedAt).toBe(row === undefined ? -1 : row.createdAt + 5_000);
  });

  it('fails a run the person refuses', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const { settled } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 'a', text: 'b' }), caller: AGENT });
    await settle();
    const approval = r.bus.of('approval')[0]?.approval;
    await r.module.policies.answer(approval?.id ?? NO_APPROVAL, { by: ALICE, approve: false, remember: 'once', reason: 'no' });
    expect(await settled).toMatchObject({ status: 'cancelled', error: { code: 'denied', message: 'Declined by the approver: no' } });
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

  it('marks a run watched only for a chat turn on a session someone has open, never nested or sessionless (build 7)', async () => {
    const r = await started();
    r.catalog.add('fs', 'outer', outer);
    const fs = r.connect('fs');
    const session = await r.session();
    const turn = await r.turn({ session: session.id });
    const watchedOf = (run: RunId): boolean | undefined => fs.requests.find((request) => request.run.id === run)?.run.watched;
    r.presence.active = true;
    const top = await r.module.runs.start({ ...input(turn, 'fs/outer', {}), session: session.id });
    const child = await r.module.runs.start({ ...input(turn, 'fs/copy', { from: 'a' }), session: session.id, parent: top.run, key: 'c' });
    const nested = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'b' }), session: session.id, parent: child.run, key: 'n' });
    const sessionless = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'c' }), key: 's' });
    await Promise.all([top.settled, child.settled, nested.settled, sessionless.settled]);
    expect([watchedOf(top.run), watchedOf(child.run), watchedOf(nested.run), watchedOf(sessionless.run)]).toEqual([true, true, undefined, undefined]);
    r.presence.active = false;
    const away = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'd' }), session: session.id, key: 'away' });
    await away.settled;
    expect(watchedOf(away.run)).toBeUndefined();
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

/** A run of fs/read that keeps running until the test ends. */
async function running(r: ExecutionRig, turn: Turn): Promise<RunId> {
  r.connect('fs').behaviour.run = () => new Promise(() => undefined);
  const { run } = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'slow' }), key: 'slow' });
  await until(async () => (await r.module.runs.get(run))?.status === 'running', 'the run to start');
  return run;
}

describe('refusing runs', () => {
  it('refuses a fn an admin switched off, or one that is unavailable, before making a run', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    r.catalog.set('fs/read', { disabled: true });
    await expect(r.module.runs.start(input(turn, 'fs/read', { path: 'a' }))).rejects.toMatchObject({ error: { code: 'disabled', class: 'caller', message: 'fs/read is turned off.' } });
    r.catalog.set('fs/read', { disabled: false, available: { unavailable: 'system-disconnected', detail: 'fs is offline' } });
    await expect(r.module.runs.start(input(turn, 'fs/read', { path: 'a' }))).rejects.toMatchObject({ error: { code: 'unavailable', class: 'retry', message: 'fs/read is unavailable: fs is offline' } });
    expect(await r.store.table('runs').count()).toBe(0);
  });

  it('runs an admin’s test call of an installed system’s fn, marked as a test, and nothing else of it (build 7)', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    await r.store.table('systems').put({ ...systemRow('fs', 'connected'), stage: 'installed' });
    r.catalog.set('fs/read', { available: { unavailable: 'held', detail: 'fs is installed and waits for an admin to review it and go live' } });
    await expect(r.module.runs.start(input(turn, 'fs/read', { path: 'a' }))).rejects.toMatchObject({ error: { code: 'unavailable' } });
    const { run } = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'a' }), test: true });
    expect((await r.store.table('runs').get(run))?.test).toBe(true);
    // a system that is not connected can't be tested either
    await r.store.table('systems').update(SystemName.parse('fs'), { status: 'disconnected' });
    await expect(r.module.runs.start({ ...input(turn, 'fs/read', { path: 'b' }), key: 'b', test: true })).rejects.toMatchObject({ error: { code: 'unavailable' } });
  });

  it('refuses a child call (ctx.fns) to a fn that was switched off', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const parent = await r.module.runs.start(input(turn, 'fs/copy', { from: 'x' }));
    r.catalog.set('fs/read', { disabled: true });
    await expect(r.module.runs.start({ ...input(turn, 'fs/read', { path: 'x' }), parent: parent.run, key: 'read' })).rejects.toMatchObject({ error: { code: 'disabled' } });
  });

  it('fails a run a policy denies, without asking anyone', async () => {
    const r = await started();
    const fs = r.connect('fs');
    await r.store.table('policies').insert({
      id: PolicyId.parse('pol_deny'), description: 'No reading today.', subject: { everyone: true }, target: { fn: 'fs/read' },
      decision: { effect: 'deny', reason: 'reading is off today' }, priority: 10, createdBy: ALICE, createdAt: 0,
    });
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'a' }));
    expect(await settled).toEqual({ status: 'failed', error: { class: 'caller', message: 'Not allowed: reading is off today', code: 'denied' } });
    expect(fs.requests).toEqual([]);
    expect(r.bus.of('approval')).toEqual([]);
  });

  it('holds a queued run while its fn is paused, and fails one whose fn is gone when its turn comes', async () => {
    const r = await started();
    const fs = r.connect('fs');
    const turn = await r.turn();
    r.catalog.set('fs/read', { paused: true });
    const held = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'a' }), key: 'held' });
    await settle(40);
    expect((await r.module.runs.get(held.run))?.status).toBe('queued');
    expect(fs.requests).toEqual([]);
    r.catalog.set('fs/read', { paused: false });
    expect(await held.settled).toEqual({ status: 'done', result: { echo: { path: 'a' } } });

    r.catalog.set('fs/read', { paused: true });
    const gone = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'b' }), key: 'gone' });
    r.catalog.records.delete('fs/read');
    expect(await gone.settled).toMatchObject({ status: 'failed', error: { code: 'not-found', message: 'fs/read no longer exists.' } });
  });

  it('starts a run straight in the background, so its caller stops waiting at once', async () => {
    const r = await started();
    r.connect('fs').behaviour.run = () => new Promise(() => undefined);
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'a' }), background: true });
    expect(await settled).toEqual({ status: 'background', run });
    expect((await r.module.runs.get(run))?.background).toBe(true);
  });
});

describe('controlling runs', () => {
  /** `hub/run_wait` with pause allowed: a hub run that runs until it is stopped. */
  async function hubRun(r: ExecutionRig, turn: Turn, waitFor: RunId) {
    r.catalog.add('hub', 'run_wait', fn({ description: 'Wait.', args: hub.fns.run_wait.args, returns: hub.fns.run_wait.returns, tags: ['read'], resume: g.obj({}) }));
    const begun = await r.module.runs.start({ ...input(turn, 'hub/run_wait', { run: waitFor, timeout: 60_000 }), key: 'wait' });
    await until(async () => (await r.module.runs.get(begun.run))?.status === 'running', 'the hub run to start');
    return begun;
  }

  it('cancels a running hub run by aborting it', async () => {
    const r = await started();
    const turn = await r.turn();
    const { run, settled } = await hubRun(r, turn, await running(r, turn));
    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: true });
    expect(await settled).toEqual({ status: 'cancelled' });
  });

  it('pauses a running hub run, accepts pausing it again, and cancels it while paused', async () => {
    const r = await started();
    const turn = await r.turn();
    const { run, settled } = await hubRun(r, turn, await running(r, turn));
    expect(await r.module.runs.pause(run, ALICE)).toEqual({ accepted: true });
    await until(async () => (await r.module.runs.get(run))?.status === 'paused', 'the hub run to pause');
    expect(await r.module.runs.pause(run, ALICE)).toEqual({ accepted: true });
    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: true });
    expect(await settled).toEqual({ status: 'cancelled' });
  });

  it('refuses to control a missing run, a run that does not allow it, and a run whose fn is gone', async () => {
    const r = await started();
    const turn = await r.turn();
    expect(await r.module.runs.cancel(RunId.parse('run_none'), ALICE)).toEqual({ accepted: false, reason: 'There is no run run_none.' });
    const run = await running(r, turn);
    expect(await r.module.runs.pause(run, ALICE)).toEqual({ accepted: false, reason: 'This run can\'t be paused now.' });
    r.catalog.records.delete('fs/read');
    expect(await r.module.runs.cancel(run, ALICE)).toEqual({ accepted: false, reason: 'fs/read no longer exists.' });
  });

  it('refuses to undo a run that is still going, or whose fn has no undo', async () => {
    const r = await started();
    const turn = await r.turn();
    const run = await running(r, turn);
    await r.module.runs.undoWith(run, { path: 'slow' });
    expect(await r.module.runs.undo(run, ALICE)).toEqual({ status: 'failed', error: { class: 'caller', message: 'The run has not finished yet.', code: 'running' } });
    r.connect('fs').behaviour.run = () => Promise.resolve({ status: 'done', result: 'x', undo: { path: 'a' } });
    const read = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'a' }), key: 'read' });
    await read.settled;
    expect(await r.module.runs.undo(read.run, ALICE)).toEqual({ status: 'failed', error: { class: 'caller', message: 'fs/read can\'t be undone.', code: 'not-undoable' } });
    expect(await r.module.runs.undo(RunId.parse('run_none'), ALICE)).toMatchObject({ status: 'failed', error: { code: 'not-found' } });
  });
});

describe('fleets', () => {
  const LAPTOP = InstanceName.parse('laptop');
  const FS = SystemName.parse('fs');
  const SEVERAL: InvalidInput = { source: 'validation', problems: [{ path: 'on', message: 'fs has several machines: say on=laptop or on=desk' }] };

  it('asks the router once which instance a system’s run goes to, with the caller’s pick, args and session, and keeps it on the run', async () => {
    const asked: unknown[] = [];
    const r = await started({ instances: { route: (q) => { asked.push(q); return Promise.resolve({ instance: { system: FS, instance: LAPTOP } }); } } });
    const fs = r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({ ...input(turn, 'fs/read', { path: 'a' }), on: LAPTOP });
    await settled;
    expect(fs.requests.map((request) => request.run.system.instance)).toEqual([LAPTOP]);
    expect(asked).toEqual([{ system: 'fs', args: { path: 'a' }, on: LAPTOP, session: undefined }]);
    expect((await r.module.runs.get(run))?.instance).toBe(LAPTOP);
  });

  it('settles a call the router can’t place as invalid input naming the choices, never running it', async () => {
    const r = await started({ instances: { route: () => Promise.resolve({ invalid: SEVERAL }) } });
    const fs = r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: 'a' }));
    expect(await settled).toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE, message: 'on: fs has several machines: say on=laptop or on=desk' } });
    expect((await r.module.runs.get(run))?.outcome).toEqual({ status: 'invalid-input', invalid: SEVERAL });
    expect(fs.requests).toEqual([]);
  });

  it('never routes args that are already refused', async () => {
    const asked: unknown[] = [];
    const r = await started({ instances: { route: (q) => { asked.push(q); return Promise.resolve({ invalid: SEVERAL }); } } });
    r.connect('fs');
    const turn = await r.turn();
    const { run } = await r.module.runs.start(input(turn, 'fs/write', { path: 3 }));
    expect((await r.module.runs.get(run))?.outcome).toMatchObject({ status: 'invalid-input', invalid: { source: 'schema' } });
    expect(asked).toEqual([]);
  });
});

describe('refused input', () => {
  it('settles args that don’t fit as invalid input at once, with the problems by path, and never runs the fn', async () => {
    const r = await started();
    const fs = r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({ ...input(turn, 'fs/write', { path: 3 }), caller: AGENT });
    expect(await settled).toMatchObject({ status: 'failed', error: { class: 'caller', code: INVALID_INPUT_CODE } });
    const row = await r.module.runs.get(run);
    expect(row?.status).toBe('invalid-input');
    expect(row?.outcome).toMatchObject({ status: 'invalid-input', invalid: { source: 'schema' } });
    const problems = row?.outcome?.status === 'invalid-input' ? row.outcome.invalid.problems.map((p) => p.path) : [];
    expect(problems).toEqual(expect.arrayContaining(['path', 'text']));
    expect(fs.requests).toEqual([]);
    // no approval was asked for input that was refused anyway
    expect(r.bus.of('approval')).toEqual([]);
  });

  it('settles input its caller couldn’t read as invalid input, keeping what the model wrote', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const invalid = { source: 'json' as const, problems: [{ path: '', message: 'Unexpected end of JSON input' }], raw: '{"path": "a' };
    const { run } = await r.module.runs.start({ ...input(turn, 'fs/read', {}), invalid });
    expect((await r.module.runs.get(run))?.outcome).toEqual({ status: 'invalid-input', invalid });
  });

  it('settles a fn’s own refusal (`ctx.invalid`) as invalid input', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.run = () => Promise.resolve({ status: 'invalid-input', invalid: { source: 'validation', problems: [{ path: 'path', message: 'outside the root' }] } });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/read', { path: '/etc' }));
    expect(await settled).toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE, message: 'path: outside the root' } });
    expect((await r.module.runs.get(run))?.status).toBe('invalid-input');
  });

  it('reads problems off a schema check', () => {
    expect(invalidArgs(z.object({ a: z.string() }).safeParse({ a: 'x' }))).toBeUndefined();
    expect(invalidArgs(z.object({ a: z.object({ b: z.number() }) }).safeParse({ a: { b: 'x' } }))).toMatchObject({ source: 'schema', problems: [{ path: 'a.b' }] });
  });
});
