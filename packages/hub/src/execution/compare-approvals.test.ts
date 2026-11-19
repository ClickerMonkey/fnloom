/** A/B compare through the run service: a run in a variant's fork asks the person for each write, marked with the variant. */
import { fn, g } from '@harness/sdk';
import { MAIN_INSTANCE, PolicyId, SessionId, TurnId, type Approval, type CompareFork, type Json, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInput } from './index.ts';
import { ALICE, executionRig, SESSION, settle, type ExecutionRig } from './testing.ts';

const write = fn({ description: 'Write a file.', args: g.obj({ path: g.text() }), returns: g.num() });
const FORK = SessionId.parse('ses_fork');
const VARIANT: CompareFork = { turn: TurnId.parse('trn_compared'), variant: 1, label: 'Fast' };

let rig: ExecutionRig;
afterEach(async () => { await rig.module.stop(); });

/** A rig with `fs/write` allowed for everyone by a policy, Alice's chat, and a variant's fork of it. */
async function started(): Promise<ExecutionRig> {
  rig = await executionRig();
  rig.catalog.add('fs', 'write', write);
  await rig.store.table('actors').insert({ id: ALICE, kind: 'user', name: 'Alice', about: '', email: 'alice@example.com', role: 'admin', createdAt: 0, disabled: false });
  await rig.store.table('policies').insert({
    id: PolicyId.parse('pol_allow'), description: 'writes are fine', priority: 0, createdBy: ALICE, createdAt: 0,
    subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'allow' },
  });
  const participants = [{ actor: ALICE, role: 'owner' as const, notify: 'all' as const, joinedAt: 0 }];
  await rig.session({ participants });
  await rig.session({ id: FORK, participants, forkOf: SESSION, fork: VARIANT });
  await rig.module.start();
  return rig;
}

const input = (turn: Turn, key: string, args: Json): RunInput => ({
  fn: 'fs/write', args, turn: turn.id, ...(turn.session === undefined ? {} : { session: turn.session }), key, actor: ALICE, caller: ALICE,
  priority: 'interactive', background: false, handlers: [], on: MAIN_INSTANCE,
});

const lastApproval = (r: ExecutionRig): Approval => {
  const approval = r.bus.of('approval').at(-1)?.approval;
  if (approval === undefined) throw new Error('no approval was published');
  return approval;
};

describe('a compare variant\'s writes', () => {
  it('run at once in the chat, but ask in a variant, marked with it, whatever the policy allows', async () => {
    const r = await started();
    r.connect('fs');
    const chat = await r.module.runs.start(input(await r.turn({ session: SESSION }), 'chat', { path: 'a' }));
    expect(await chat.settled).toMatchObject({ status: 'done' });

    const forked = await r.module.runs.start(input(await r.turn({ session: FORK }), 'variant', { path: 'a' }));
    expect((await r.module.runs.get(forked.run))?.status).toBe('awaiting-approval');
    expect(lastApproval(r)).toMatchObject({ fn: 'fs/write', approver: { by: 'turn-user' }, variant: VARIANT });
  });

  it('never remembers a variant\'s answer, so "always" there neither allows the next write nor reaches the chat', async () => {
    const r = await started();
    r.connect('fs');
    const turn = await r.turn({ session: FORK });
    const first = await r.module.runs.start(input(turn, 'k1', { path: 'a' }));
    await settle();
    const policies = await r.store.table('policies').count({});
    await r.module.policies.answer(lastApproval(r).id, { by: ALICE, approve: true, remember: 'always' });
    expect(await first.settled).toMatchObject({ status: 'done' });
    expect(await r.store.table('policies').count({})).toBe(policies);
    const second = await r.module.runs.start(input(turn, 'k2', { path: 'b' }));
    expect((await r.module.runs.get(second.run))?.status).toBe('awaiting-approval');
  });
});
