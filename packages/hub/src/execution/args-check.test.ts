/**
 * A fn's args check before approval (`FnDecl.check`, `checkArgs` on the system link): it runs once the args parse and
 * before the policies, so problems settle the run as invalid input and no approval is ever made; a check that can't
 * run (its system gone, an error, the deadline) lets the call go on to its approval as before; and the check's own
 * calls are held to reads of the deps it declares, never waiting for anyone.
 */
import { fn, g } from '@harness/sdk';
import { ActorId, PolicyId, SystemName, type Json, type QualifiedName, type RunId, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInput } from './index.ts';
import { CHECK_CALL_CODE } from './runs.ts';
import { ALICE, executionRig, settle, testSettings, type ExecutionRig, type TestSystem } from './testing.ts';

const write = fn({ description: 'Insert rows.', args: g.obj({ table: g.text() }), returns: g.num() });
const read = fn({ description: 'Read a table.', args: g.obj({ table: g.text() }), returns: g.text(), tags: ['read'] });
const drop = fn({ description: 'Drop a table.', args: g.obj({ table: g.text() }), returns: g.bool() });
const FS_ACTOR = ActorId.parse('act_fs');

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

/** A rig whose `fs/write` always asks with a preview and checks its args, reading `fs/read` (its `fs/drop` dep writes). */
async function started(options: { timeout?: number; checks?: QualifiedName[] } = {}): Promise<{ r: ExecutionRig; fs: TestSystem }> {
  rig = await executionRig(options.timeout === undefined ? {} : { settings: testSettings({}, { HARNESS_ARGS_CHECK_TIMEOUT: options.timeout }) });
  const record = rig.catalog.add('fs', 'write', write);
  rig.catalog.add('fs', 'read', read);
  rig.catalog.add('fs', 'drop', drop);
  rig.catalog.set(record.name, { decl: { ...record.decl, deps: ['fs/read', 'fs/drop'], approval: { preview: true, remember: false }, check: { deps: options.checks ?? ['fs/read'] } } });
  await rig.store.table('actors').insert({ id: ALICE, kind: 'user', name: 'Alice', about: '', email: 'alice@example.com', role: 'admin', createdAt: 0, disabled: false });
  await rig.store.table('actors').insert({ id: FS_ACTOR, kind: 'system', system: SystemName.parse('fs'), name: 'fs', about: '', createdAt: 0, disabled: false });
  await rig.store.table('systems').put({
    name: SystemName.parse('fs'), description: '', status: 'connected', enabled: { functions: true, renderers: true }, version: '1.0.0', manifestHash: '', actor: FS_ACTOR,
  });
  await rig.module.start();
  return { r: rig, fs: rig.connect('fs') };
}

const input = (turn: Turn, name: QualifiedName, args: Json, extra: Partial<RunInput> = {}): RunInput => ({
  fn: name, args, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [], ...extra,
});

/** A call the check makes, as the system's link would make it: a child of the queued run, under a `check:` key. */
async function checkCall(r: ExecutionRig, turn: Turn, run: string, name: QualifiedName, key = 'check:read#1') {
  const started = await r.module.runs.start(input(turn, name, { table: 'orders' }, { parent: run as RunId, key, caller: FS_ACTOR }));
  return started.settled;
}

describe('a fn that checks its args before approval', () => {
  it('runs the check before the policies: problems settle the run as invalid input and no approval is made', async () => {
    const { r, fs } = await started();
    fs.behaviour.checkArgs = () => ({ problems: [{ path: 'table', message: 'orders is not a table: give one of customers, invoices.' }] });
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    expect(await settled).toMatchObject({ status: 'failed', error: { code: 'invalid-input', message: 'table: orders is not a table: give one of customers, invoices.' } });
    expect((await r.module.runs.get(run))?.outcome).toMatchObject({ status: 'invalid-input', invalid: { source: 'validation', problems: [{ path: 'table' }] } });
    expect(fs.argChecks).toMatchObject([{ run, fn: 'write', args: { table: 'orders' }, user: { id: ALICE } }]);
    // the person was never asked, and the system was never asked for its card
    expect(r.bus.of('approval')).toHaveLength(0);
    expect(fs.previews).toHaveLength(0);
    expect(fs.requests).toHaveLength(0);
  });

  it('goes on to the approval as before when the check finds nothing, with its read calls kept as the run\'s children', async () => {
    const { r, fs } = await started();
    const turn = await r.turn();
    const children: Array<Awaited<ReturnType<typeof checkCall>>> = [];
    fs.behaviour.checkArgs = async (request) => {
      children.push(await checkCall(r, turn, request.run, 'fs/read'));
      return { problems: [] };
    };
    fs.behaviour.run = (request) => Promise.resolve(request.fn === 'read' ? { status: 'done', result: 'orders: 3 rows' } : { status: 'done', result: 1 });
    const { run } = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    expect((await r.module.runs.get(run))?.status).toBe('awaiting-approval');
    expect(children).toEqual([{ status: 'done', result: 'orders: 3 rows' }]);
    expect((await r.store.table('runs').find({ where: { parent: run }, limit: 5 })).items).toMatchObject([{ fn: 'fs/read', key: 'check:read#1', status: 'done' }]);
    expect(r.bus.of('approval')).toHaveLength(1);
  });

  it('lets the call go on to its approval when the check fails, times out or its system is gone', async () => {
    const { r, fs } = await started({ timeout: 100 });
    const turn = await r.turn();
    fs.behaviour.checkArgs = () => { throw new Error('the check broke'); };
    const broken = await r.module.runs.start(input(turn, 'fs/write', { table: 'a' }));
    expect((await r.module.runs.get(broken.run))?.status).toBe('awaiting-approval');
    fs.behaviour.checkArgs = (_request, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ problems: [{ path: '', message: 'too late' }] }); }); });
    const slow = await r.module.runs.start(input(turn, 'fs/write', { table: 'b' }, { key: 'k2' }));
    expect((await r.module.runs.get(slow.run))?.status).toBe('awaiting-approval');
    expect(r.bus.of('approval')).toHaveLength(2);
    // a check's call that comes after the hub stopped waiting is refused, never run under the waiting run
    await expect(checkCall(r, turn, slow.run, 'fs/read', 'check:read#9')).rejects.toMatchObject({ error: { code: CHECK_CALL_CODE, message: expect.stringContaining('is over') } });
  });

  it('holds the check to reads of the deps it declares, and never lets one of its calls wait for approval', async () => {
    const { r, fs } = await started({ checks: ['fs/read', 'fs/drop'] });
    const turn = await r.turn();
    const refused: unknown[] = [];
    fs.behaviour.checkArgs = async (request) => {
      // a write dep, even one the check names, is refused: a check only reads
      refused.push(await checkCall(r, turn, request.run, 'fs/drop', 'check:drop#1').catch((error: unknown) => error));
      return { problems: [] };
    };
    await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    expect(refused).toMatchObject([{ error: { code: CHECK_CALL_CODE, message: expect.stringContaining('may only read') } }]);
  });

  it('refuses a call to a dep the check doesn\'t declare, and denies a read that would ask instead of asking', async () => {
    const { r, fs } = await started();
    const turn = await r.turn();
    const outcomes: unknown[] = [];
    fs.behaviour.checkArgs = async (request) => {
      outcomes.push(await checkCall(r, turn, request.run, 'fs/drop', 'check:drop#1').catch((error: unknown) => error));
      return { problems: [] };
    };
    await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    expect(outcomes).toMatchObject([{ error: { code: CHECK_CALL_CODE, message: expect.stringContaining('only the deps its check declares (fs/read)') } }]);
    // a read that a policy says to ask about is denied, so no approval waits behind a check
    await r.store.table('policies').insert({
      id: PolicyId.parse('pol_ask_reads'), description: 'ask about reads', priority: 10, createdBy: ALICE, createdAt: 0,
      subject: { everyone: true }, target: { fn: 'fs/read' }, decision: { effect: 'ask', approver: { by: 'turn-user' } },
    });
    fs.behaviour.checkArgs = async (request) => {
      outcomes.push(await checkCall(r, turn, request.run, 'fs/read', 'check:read#2'));
      return { problems: [] };
    };
    const asked = await r.module.runs.start(input(turn, 'fs/write', { table: 'x' }, { key: 'k3' }));
    await settle();
    expect(outcomes[1]).toMatchObject({ status: 'failed', error: { code: 'denied', message: expect.stringContaining('can\'t wait for anyone') } });
    const approvals = r.bus.of('approval').map((event) => event.approval.fn);
    expect(approvals).not.toContain('fs/read');
    expect((await r.module.runs.get(asked.run))?.status).toBe('awaiting-approval');
  });
});
