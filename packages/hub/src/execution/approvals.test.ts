/** Build 5: fns that always ask (with a preview from their system), declines the caller can read, and runs systems propose. */
import { fn, g } from '@harness/sdk';
import { ActorId, MAIN_INSTANCE, SystemName, type Approval, type FnApproval, type ProposedRun, type Json, type QualifiedName, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInput } from './index.ts';
import { ALICE, executionRig, settle, until, type ExecutionRig } from './testing.ts';

const write = fn({ description: 'Insert rows.', args: g.obj({ table: g.text() }), returns: g.num(), tags: ['read'] });
const PREVIEW = { title: 'Insert 1 row into orders', parts: [{ type: 'code' as const, language: 'sql', code: 'INSERT INTO orders …' }], irreversible: false };
const HUB_ACTOR = ActorId.parse('act_hub');
const FS_ACTOR = ActorId.parse('act_fs');

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

/** A rig whose `fs/write` always asks, with Alice and the hub and fs actors stored. */
async function started(approval: FnApproval = { preview: true, remember: false }): Promise<ExecutionRig> {
  rig = await executionRig();
  const record = rig.catalog.add('fs', 'write', write);
  rig.catalog.set(record.name, { decl: { ...record.decl, approval } });
  await rig.store.table('actors').insert({ id: ALICE, kind: 'user', name: 'Alice', about: '', email: 'alice@example.com', role: 'admin', createdAt: 0, disabled: false });
  await rig.store.table('actors').insert({ id: HUB_ACTOR, kind: 'system', system: SystemName.parse('hub'), name: 'Harness', about: '', createdAt: 0, disabled: false });
  await rig.store.table('actors').insert({ id: FS_ACTOR, kind: 'system', system: SystemName.parse('fs'), name: 'fs', about: '', createdAt: 0, disabled: false });
  await rig.store.table('systems').put({
    name: SystemName.parse('fs'), description: '', status: 'connected', enabled: { functions: true, renderers: true }, version: '1.0.0', manifestHash: '', actor: FS_ACTOR,
  });
  await rig.module.start();
  return rig;
}

const input = (turn: Turn, name: QualifiedName, args: Json): RunInput => ({
  fn: name, args, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
});

const lastApproval = (r: ExecutionRig): Approval => {
  const approval = r.bus.of('approval').at(-1)?.approval;
  if (approval === undefined) throw new Error('no approval was published');
  return approval;
};

describe('fns that always ask', () => {
  it('asks even for a read fn its own person runs, keeping the preview its system worked out', async () => {
    const r = await started();
    const fs = r.connect('fs');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    expect((await r.module.runs.get(run))?.status).toBe('awaiting-approval');
    expect(fs.previews[0]).toMatchObject({ run, fn: 'write', args: { table: 'orders' }, user: { id: ALICE } });
    const approval = lastApproval(r);
    expect(approval.preview?.title).toBe('Do it');
    await r.module.policies.answer(approval.id, { by: ALICE, approve: true, remember: 'once' });
    expect(await settled).toMatchObject({ status: 'done' });
  });

  it('settles as invalid input with the system’s reason when it refuses the preview', async () => {
    const r = await started();
    const fs = r.connect('fs');
    fs.behaviour.preview = () => ({ refused: 'orders is read-only' });
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    const outcome = await settled;
    expect(outcome.status === 'failed' ? outcome.error.message : outcome.status).toContain('orders is read-only');
    expect(r.bus.of('approval')).toHaveLength(0);
  });

  it('never remembers an answer when its approvals may not be remembered', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn();
    const first = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    await settle();
    await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: true, remember: 'always' });
    await first.settled;
    expect(await r.store.table('policies').count({})).toBe(0);
    const second = await r.module.runs.start({ ...input(turn, 'fs/write', { table: 'orders' }), key: 'k2' });
    expect((await r.module.runs.get(second.run))?.status).toBe('awaiting-approval');
  });

  it('tells the caller who declined and why', async () => {
    const r = await started({ preview: false, remember: true });
    r.connect('fs');
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    await settle();
    await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: false, remember: 'once', reason: 'not that table' });
    expect(await settled).toMatchObject({ status: 'cancelled', error: { code: 'denied', message: 'Declined by Alice: not that table' } });
    // build 6: a declined run is cancelled, with who declined and why in its errors
    const runs = await r.store.table('runs').find({ where: { fn: 'fs/write' }, limit: 1 });
    expect(runs.items[0]).toMatchObject({ status: 'cancelled', errors: [{ error: { message: 'Declined by Alice: not that table' } }] });
  });

  it('asks the admins when its approver is the admins, and tells the run what was approved (build 6)', async () => {
    const r = await started({ preview: true, remember: false, approver: 'admins' });
    const fs = r.connect('fs');
    const turn = await r.turn();
    const { settled } = await r.module.runs.start(input(turn, 'fs/write', { table: 'orders' }));
    await settle();
    const approval = lastApproval(r);
    expect(approval.approver).toEqual({ by: 'admins' });
    await r.module.policies.answer(approval.id, { by: ALICE, approve: true, remember: 'once' });
    expect(await settled).toMatchObject({ status: 'done' });
    expect(fs.requests[0]?.approved).toMatchObject({ by: ALICE, preview: { title: 'Do it' } });
  });
});

describe('runs a system proposes', () => {
  it('adds a waiting child of its run for that run’s person, once per key, that runs when approved', async () => {
    const r = await started();
    const fs = r.connect('fs');
    let parent = '';
    const seen: { proposed?: ProposedRun } = {};
    fs.behaviour.run = async (request) => {
      if (request.fn !== 'write' || parent !== '') return { status: 'done', result: 1 };
      parent = request.run.id;
      await until(() => seen.proposed !== undefined, 'the proposal');
      return { status: 'done', result: 0 };
    };
    const turn = await r.turn();
    // the parent: an approved write, which proposes another write while it runs
    const outer = await r.module.runs.start(input(turn, 'fs/write', { table: 'a' }));
    await settle();
    await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: true, remember: 'once' });
    await until(() => parent !== '', 'the parent to run');
    const ask = { fn: 'write', args: { table: 'b' }, key: 'p1', parent: (await r.module.runs.get(outer.run))?.id, approver: 'person' as const, preview: PREVIEW, system: SystemName.parse('fs'), instance: MAIN_INSTANCE };
    const proposed = await r.module.runs.propose(ask);
    seen.proposed = proposed;
    expect(await r.module.runs.propose(ask)).toEqual(proposed);
    const child = await r.module.runs.get(proposed.run);
    expect(child).toMatchObject({ status: 'awaiting-approval', parent: outer.run, turn: turn.id, actor: ALICE });
    const approval = lastApproval(r);
    expect(approval).toMatchObject({ id: proposed.approval, proposed: true, preview: PREVIEW, approver: { by: 'turn-user' } });
    await r.module.policies.answer(approval.id, { by: ALICE, approve: true, remember: 'once' });
    expect(await r.module.runs.wait(proposed.run)).toMatchObject({ status: 'done' });
  });

  it('outside a run, makes a turn of the system’s own that the admins answer and that ends with the run', async () => {
    const r = await started();
    r.connect('fs');
    const proposed = await r.module.runs.propose({ fn: 'write', args: { table: 'b' }, key: 'scan-1', approver: 'admins', preview: PREVIEW, system: SystemName.parse('fs'), instance: MAIN_INSTANCE });
    const run = await r.module.runs.get(proposed.run);
    expect(run).toMatchObject({ status: 'awaiting-approval', actor: FS_ACTOR, caller: FS_ACTOR, instance: MAIN_INSTANCE });
    expect(lastApproval(r).approver).toEqual({ by: 'admins' });
    expect((await r.module.runs.propose({ fn: 'write', args: { table: 'b' }, key: 'scan-1', approver: 'admins', preview: PREVIEW, system: SystemName.parse('fs'), instance: MAIN_INSTANCE })).run).toBe(proposed.run);
    await r.module.runs.cancel(proposed.run, ALICE);
    await until(() => r.chat.settled.some((s) => s.turn === run?.turn), 'the system turn to end');
  });

  it('outside a run, proposes afresh under a key whose earlier proposal settled', async () => {
    const r = await started();
    r.connect('fs');
    const ask = { fn: 'write', args: { table: 'b' }, key: 'scan-2', approver: 'admins' as const, preview: PREVIEW, system: SystemName.parse('fs'), instance: MAIN_INSTANCE };
    const first = await r.module.runs.propose(ask);
    // cancelled here; a decline settles it the same way
    await r.module.runs.cancel(first.run, ALICE);
    expect(await r.module.runs.wait(first.run)).toMatchObject({ status: 'cancelled' });
    const again = await r.module.runs.propose(ask);
    expect(again.run).not.toBe(first.run);
    expect(await r.module.runs.get(again.run)).toMatchObject({ status: 'awaiting-approval' });
    await r.module.runs.cancel(again.run, ALICE);
  });

  it('refuses a fn of another system and args that don’t fit', async () => {
    const r = await started();
    r.connect('fs');
    const base = { key: 'x', approver: 'admins' as const, preview: PREVIEW, system: SystemName.parse('fs'), instance: MAIN_INSTANCE };
    await expect(r.module.runs.propose({ ...base, fn: 'nope', args: {} })).rejects.toThrow(/no fn fs\/nope/);
    await expect(r.module.runs.propose({ ...base, fn: 'write', args: { table: 3 } })).rejects.toThrow(/don't fit/);
  });
});
