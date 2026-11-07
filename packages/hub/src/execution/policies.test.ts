import { fn, g } from '@harness/sdk';
import { ActorId, PolicyId, RunId, SystemName, TurnId, type FnRecord, type Policy } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MemoryBus, MemoryStore, memoryLog } from '../catalog/testing.ts';
import { choosePolicy, globMatches, HubPolicyEngine, subjectRank, targetRank, type ActorFacts } from './policies.ts';
import { ALICE, ALICE_INFO, SESSION, TestCatalog } from './testing.ts';

const BOB = ActorId.parse('act_bob');
const ENG = ActorId.parse('act_eng');
const RUN = RunId.parse('run_1');
const TRN = TurnId.parse('trn_1');

const catalog = new TestCatalog();
const write = catalog.add('fs', 'write', fn({ description: 'Write.', args: g.obj({ path: g.text() }), returns: g.bool(), tags: ['files'] }));
const read = catalog.add('fs', 'read', fn({ description: 'Read.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read', 'files'] }));

const alice: ActorFacts = { id: ALICE, kind: 'user', groups: new Set([ENG]) };
let n = 0;
const policy = (values: Partial<Policy> & Pick<Policy, 'subject' | 'target' | 'decision'>): Policy => ({
  id: PolicyId.parse(`pol_${++n}`), description: 'p', priority: 0, createdBy: ALICE, createdAt: 0, ...values,
});

describe('matching', () => {
  it('matches globs over qualified names', () => {
    expect(globMatches('fs/*', 'fs/read')).toBe(true);
    expect(globMatches('fs/*', 'fs/Entry.reveal')).toBe(true);
    expect(globMatches('*/read', 'db/read')).toBe(true);
    expect(globMatches('fs/*', 'fsx/read')).toBe(false);
    expect(globMatches('**', 'a/b')).toBe(true);
  });

  it('ranks subjects from one actor down to everyone', () => {
    expect(subjectRank({ actor: ALICE }, alice)).toBe(4);
    expect(subjectRank({ group: ENG }, alice)).toBe(3);
    expect(subjectRank({ kind: 'user' }, alice)).toBe(2);
    expect(subjectRank({ everyone: true }, alice)).toBe(1);
    expect(subjectRank({ actor: BOB }, alice)).toBeUndefined();
    expect(subjectRank({ kind: 'agent' }, alice)).toBeUndefined();
  });

  it('ranks targets by name, then system, kind and tags, and never allows on a predicate it cannot check', () => {
    expect(targetRank({ fn: 'fs/write' }, write, 'allow')).toBe(8);
    expect(targetRank({ fn: 'fs/*' }, write, 'allow')).toBe(4);
    expect(targetRank({ system: SystemName.parse('fs') }, write, 'allow')).toBe(2);
    expect(targetRank({ tags: ['files'] }, write, 'allow')).toBe(1);
    expect(targetRank({ tags: ['read'] }, write, 'allow')).toBeUndefined();
    expect(targetRank({ fn: 'fs/write', when: { op: 'x' } }, write, 'allow')).toBeUndefined();
    expect(targetRank({ fn: 'fs/write', when: { op: 'x' } }, write, 'deny')).toBe(8);
  });

  it('chooses by priority, then specificity, then deny over ask over allow', () => {
    const everyoneDeny = policy({ subject: { everyone: true }, target: { fn: 'fs/*' }, decision: { effect: 'deny', reason: 'no' } });
    const aliceAllow = policy({ subject: { actor: ALICE }, target: { fn: 'fs/write' }, decision: { effect: 'allow' } });
    expect(choosePolicy([everyoneDeny, aliceAllow], write, alice, 0)).toBe(aliceAllow);
    const urgentDeny = { ...everyoneDeny, priority: 5 };
    expect(choosePolicy([urgentDeny, aliceAllow], write, alice, 0)).toBe(urgentDeny);
    const askSame = policy({ subject: { actor: ALICE }, target: { fn: 'fs/write' }, decision: { effect: 'ask', approver: { by: 'turn-user' } } });
    expect(choosePolicy([aliceAllow, askSame], write, alice, 0)).toBe(askSame);
    expect(choosePolicy([{ ...aliceAllow, expiresAt: 10 }], write, alice, 20)).toBeUndefined();
  });
});

describe('the policy engine', () => {
  async function engine() {
    const store = new MemoryStore();
    const bus = new MemoryBus();
    const { log } = memoryLog();
    let i = 0;
    await store.table('turns').insert({
      id: TRN, session: SESSION, actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running',
      limits: { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, budgets: [] }, cost: 0, errors: 'feed-back', createdAt: 0,
    });
    const policies = new HubPolicyEngine({
      store, bus, log, catalog, clock: () => 0, random: () => `${++i}`,
      approvers: { approvers: (approver, turnUser) => Promise.resolve(approver.by === 'turn-user' ? [turnUser] : approver.by === 'group' ? [ALICE, BOB] : []) },
    });
    return { store, bus, policies };
  }
  const ask = { actor: ALICE, turnUser: ALICE, args: {}, session: SESSION, run: RUN, caller: BOB };

  it('allows read fns and agents, and asks the turn user for the rest', async () => {
    const { policies, bus } = await engine();
    expect(await policies.decide({ ...ask, fn: read.name })).toEqual({ effect: 'allow' });
    const asked = await policies.decide({ ...ask, fn: write.name });
    expect(asked).toMatchObject({ effect: 'ask', approval: { run: RUN, fn: 'fs/write', status: 'pending', approver: { by: 'turn-user' } } });
    expect(bus.of('approval')[0]).toMatchObject({ approvers: [ALICE], session: SESSION });
    expect(await policies.decide({ ...ask, fn: write.name, caller: ALICE })).toEqual({ effect: 'allow' });
    expect(await policies.decide({ ...ask, fn: 'fs/none' })).toMatchObject({ effect: 'deny' });
  });

  it('turns "always" into a policy, and remembers "for this session"', async () => {
    const { policies, store } = await engine();
    await store.table('runs').insert(runRow(write));
    const first = await policies.decide({ ...ask, fn: write.name });
    if (first.effect !== 'ask') throw new Error('expected ask');
    await expect(policies.answer(first.approval.id, { by: BOB, approve: true, remember: 'once' })).rejects.toThrow(/can't answer/);
    const answered = await policies.answer(first.approval.id, { by: ALICE, approve: true, remember: 'session' });
    expect(answered.status).toBe('approved');
    expect(await policies.decide({ ...ask, fn: write.name })).toEqual({ effect: 'allow' });

    const { session: _session, ...outside } = ask;
    const again = await policies.decide({ ...outside, fn: write.name });
    expect(again.effect).toBe('ask');
  });

  it('lets a "for this session" answer stand in for a policy that asks, refusals included', async () => {
    const { policies, store } = await engine();
    await store.table('runs').insert(runRow(write));
    await store.table('policies').insert(policy({ subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'ask', approver: { by: 'turn-user' } } }));
    const asked = await policies.decide({ ...ask, fn: write.name });
    if (asked.effect !== 'ask') throw new Error('expected ask');
    await policies.answer(asked.approval.id, { by: ALICE, approve: false, remember: 'session' });
    expect(await policies.decide({ ...ask, fn: write.name })).toEqual({ effect: 'deny', reason: 'refused earlier in this session' });
  });

  it('needs a quorum for a group approver and denies on the first refusal', async () => {
    const { policies, store } = await engine();
    await store.table('runs').insert(runRow(write));
    await store.table('policies').insert(policy({ subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'ask', approver: { by: 'group', group: ENG, quorum: 2 } } }));
    const asked = await policies.decide({ ...ask, fn: write.name });
    if (asked.effect !== 'ask') throw new Error('expected ask');
    expect((await policies.answer(asked.approval.id, { by: ALICE, approve: true, remember: 'always' })).status).toBe('pending');
    expect((await policies.answer(asked.approval.id, { by: BOB, approve: true, remember: 'always' })).status).toBe('approved');
    const remembered = (await store.table('policies').find({ limit: 10 })).items.filter((p) => p.decision.effect === 'allow');
    expect(remembered).toMatchObject([{ subject: { actor: ALICE }, target: { fn: 'fs/write' } }]);
  });
});

function runRow(record: FnRecord) {
  return {
    id: RUN, fn: record.name, fnVersion: 'v1', kind: record.decl.kind, system: record.system, root: RUN, turn: TRN, session: SESSION, key: 'k', actor: ALICE, caller: BOB,
    args: {}, status: 'awaiting-approval' as const, allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: 'interactive' as const,
    background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
  };
}
