import { fn, g } from '@harness/sdk';
import { ActorId, OWN_TAG, PolicyId, QualifiedName, RunId, SystemName, TurnId, type FnRecord, type Policy, type RunSettled } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RecordingBus, testStore, memoryLog, settle } from '../testing.ts';
import { RunDeciders } from './deciders.ts';
import type { RunInput } from './index.ts';
import { choosePolicy, globMatches, HubPolicyEngine, subjectRank, targetRank, type ActorFacts } from './policies.ts';
import { ALICE, ALICE_INFO, SESSION, TestCatalog } from './testing.ts';

const BOB = ActorId.parse('act_bob');
const ENG = ActorId.parse('act_eng');
const RUN = RunId.parse('run_1');
const TRN = TurnId.parse('trn_1');

const catalog = new TestCatalog();
const SHOP_ACTOR = ActorId.parse('act_shop');
const write = catalog.add('fs', 'write', fn({ description: 'Write.', args: g.obj({ path: g.text() }), returns: g.bool(), tags: ['files'] }));
const save = catalog.add('hub', 'fns_save', fn({ description: 'Save a fn of the kind the calling system owns.', args: g.obj({ name: g.text() }), returns: g.bool(), tags: [OWN_TAG] }));
const query = catalog.add('shop', 'orders', fn({ description: 'Orders.', args: g.obj({}), returns: g.text(), effects: { mode: 'read' } }));
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
    expect(targetRank({ fn: 'fs/write', when: { kind: 'new', type: { name: 'bool' }, value: true } }, write, 'allow')).toBeUndefined();
    expect(targetRank({ fn: 'fs/write', when: { kind: 'new', type: { name: 'bool' }, value: true } }, write, 'deny')).toBe(8);
  });

  it('matches a policy by the fn whose run made the call (via), at any depth, as narrower than the fn alone', () => {
    const backup = QualifiedName.parse('timer/nightly_backup');
    expect(targetRank({ fn: 'fs/write', via: backup }, write, 'allow', [backup])).toBe(12);
    expect(targetRank({ fn: 'fs/write', via: backup }, write, 'allow', [QualifiedName.parse('hub/chat'), backup])).toBe(12);
    expect(targetRank({ fn: 'fs/write', via: backup }, write, 'allow', [QualifiedName.parse('hub/chat')])).toBeUndefined();
    expect(targetRank({ fn: 'fs/write', via: backup }, write, 'allow')).toBeUndefined();
    const viaAllow = policy({ subject: { actor: ALICE }, target: { fn: 'fs/write', via: backup }, decision: { effect: 'allow' } });
    const ask = policy({ subject: { actor: ALICE }, target: { fn: 'fs/write' }, decision: { effect: 'ask', approver: { by: 'turn-user' } } });
    expect(choosePolicy([ask, viaAllow], write, alice, 0, [backup])).toBe(viaAllow);
    expect(choosePolicy([ask, viaAllow], write, alice, 0, [])).toBe(ask);
  });

  it('lets a person\'s own allow (yields) decide only when no other policy matches, so an admin\'s deny or ask wins', () => {
    const backup = QualifiedName.parse('schedule/nightly_backup');
    const own = policy({ subject: { actor: ALICE }, target: { via: backup }, decision: { effect: 'allow' }, yields: true });
    // broader and lower than it, but firm: the admin's rule decides
    const everyoneDeny = policy({ subject: { everyone: true }, target: { fn: 'fs/*' }, decision: { effect: 'deny', reason: 'no writes' } });
    const usersAsk = policy({ subject: { kind: 'user' }, target: { system: SystemName.parse('fs') }, decision: { effect: 'ask', approver: { by: 'turn-user' } } });
    expect(choosePolicy([own], write, alice, 0, [backup])).toBe(own);
    expect(choosePolicy([own, everyoneDeny], write, alice, 0, [backup])).toBe(everyoneDeny);
    expect(choosePolicy([usersAsk, own], write, alice, 0, [backup])).toBe(usersAsk);
    // only under the fn it names
    expect(choosePolicy([own], write, alice, 0, [QualifiedName.parse('hub/chat')])).toBeUndefined();
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
    const store = await testStore();
    const bus = new RecordingBus();
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

  it('lets a call through on a policy for the fn whose run made it, and asks for the same fn called any other way', async () => {
    const { policies, store } = await engine();
    const backup = QualifiedName.parse('timer/nightly_backup');
    await store.table('policies').insert(policy({ subject: { actor: ALICE }, target: { fn: 'fs/write', via: backup }, decision: { effect: 'allow' } }));
    expect(await policies.decide({ ...ask, fn: write.name, via: [backup] })).toEqual({ effect: 'allow' });
    expect(await policies.decide({ ...ask, fn: write.name, via: [QualifiedName.parse('hub/chat')] })).toMatchObject({ effect: 'ask' });
    expect(await policies.decide({ ...ask, fn: write.name })).toMatchObject({ effect: 'ask' });
  });

  it('allows read fns (by tag or effects) and agents, and asks the turn user for the rest', async () => {
    const { policies, bus } = await engine();
    expect(await policies.decide({ ...ask, fn: read.name })).toEqual({ effect: 'allow' });
    expect(await policies.decide({ ...ask, fn: query.name })).toEqual({ effect: 'allow' });
    const asked = await policies.decide({ ...ask, fn: write.name });
    expect(asked).toMatchObject({ effect: 'ask', approval: { run: RUN, fn: 'fs/write', status: 'pending', approver: { by: 'turn-user' } } });
    expect(bus.of('approval')[0]).toMatchObject({ approvers: [ALICE], session: SESSION });
    expect(await policies.decide({ ...ask, fn: write.name, caller: ALICE })).toEqual({ effect: 'allow' });
    // a system forwarding to its own fn from a run that declares at least that mode was decided with that run
    expect(await policies.decide({ ...ask, fn: write.name, withinParent: true })).toEqual({ effect: 'allow' });
    expect(await policies.decide({ ...ask, fn: 'fs/none' })).toMatchObject({ effect: 'deny' });
  });

  it('asks about a compare variant\'s writes in each variant, whatever a policy or an earlier answer allowed', async () => {
    const { policies, store } = await engine();
    await store.table('runs').insert(runRow(write));
    await store.table('policies').insert(policy({ subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'allow' } }));
    expect(await policies.decide({ ...ask, fn: write.name })).toEqual({ effect: 'allow' });
    const variant = { turn: TRN, variant: 1, label: 'Fast' };
    const asked = await policies.decide({ ...ask, fn: write.name, variant });
    expect(asked).toMatchObject({ effect: 'ask', approval: { fn: 'fs/write', approver: { by: 'turn-user' }, variant } });
    if (asked.effect !== 'ask') throw new Error('expected ask');
    // remembered for the session, a variant still asks again (each variant is approved on its own)
    await policies.answer(asked.approval.id, { by: ALICE, approve: true, remember: 'session' });
    expect(await policies.decide({ ...ask, fn: write.name, variant, caller: ALICE })).toMatchObject({ effect: 'ask' });
    // reads go ahead, and a deny still wins
    expect(await policies.decide({ ...ask, fn: read.name, variant })).toEqual({ effect: 'allow' });
    await store.table('policies').insert(policy({ subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'deny', reason: 'no' }, priority: 9 }));
    expect(await policies.decide({ ...ask, fn: write.name, variant })).toMatchObject({ effect: 'deny' });
  });

  it('allows a system calling a hub fn that changes only what it owns, and asks anyone else', async () => {
    const { policies, store } = await engine();
    await store.table('actors').put({ id: SHOP_ACTOR, kind: 'system', name: 'shop', about: '', disabled: false, system: SystemName.parse('shop'), createdAt: 0 });
    expect(await policies.decide({ ...ask, fn: save.name, caller: SHOP_ACTOR })).toEqual({ effect: 'allow' });
    expect(await policies.decide({ ...ask, fn: save.name })).toMatchObject({ effect: 'ask' });
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

describe('approvals no person answers', () => {
  const HUB = ActorId.parse('act_hubself');
  const JUDGE = QualifiedName.parse('rules/judge');

  /** An engine whose deciders run judges through a fake run service and read a fake ledger. */
  async function decided(options: { verdict?: RunSettled; left?: number } = {}) {
    const store = await testStore();
    const bus = new RecordingBus();
    const { log } = memoryLog();
    let i = 0;
    await store.table('actors').insert({ id: HUB, kind: 'system', system: SystemName.parse('hub'), name: 'Hub', about: '', createdAt: 0, disabled: false });
    await store.table('turns').insert({
      id: TRN, session: SESSION, actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running',
      limits: { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1 }, budgets: [] }, cost: 0, errors: 'feed-back', createdAt: 0,
    });
    await store.table('runs').insert({ ...runRow(write), args: { path: 'notes.md' } });
    const policies = new HubPolicyEngine({ store, bus, log, catalog, clock: () => 0, random: () => `${++i}`, approvers: { approvers: () => Promise.resolve([]) } });
    const judged: RunInput[] = [];
    policies.decideWith(new RunDeciders({
      store,
      runs: { start: (input) => { judged.push(input); return Promise.resolve({ run: RunId.parse('run_judge'), settled: Promise.resolve(options.verdict ?? { status: 'cancelled' }) }); } },
      ledger: { remaining: () => Promise.resolve({ cost: options.left ?? 0, limitedBy: 'this message' }) },
    }));
    return { store, bus, policies, judged };
  }
  const judgePolicy = () => policy({ subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'ask', approver: { by: 'judge', fn: JUDGE } } });
  const hubPolicy = () => policy({ subject: { everyone: true }, target: { fn: 'fs/write' }, decision: { effect: 'ask', approver: { by: 'hub' } } });
  const ask = { actor: ALICE, turnUser: ALICE, args: {}, session: SESSION, run: RUN, caller: BOB, fn: write.name };

  it('runs the judge fn on the waiting call, and its allow settles the approval as the hub', async () => {
    const { store, bus, policies, judged } = await decided({ verdict: { status: 'done', result: { approve: true, reason: 'only notes' } } });
    await store.table('policies').insert(judgePolicy());
    const asked = await policies.decide(ask);
    if (asked.effect !== 'ask') throw new Error('expected ask');
    expect(asked.approval.status).toBe('pending');
    await settle();
    expect(judged).toMatchObject([{ fn: JUDGE, args: { fn: 'fs/write', args: { path: 'notes.md' }, actor: ALICE }, turn: TRN, session: SESSION, caller: HUB }]);
    const approval = await store.table('approvals').get(asked.approval.id);
    expect(approval).toMatchObject({ status: 'approved', decisions: [{ by: HUB, approve: true, reason: 'only notes', remember: 'once' }] });
    expect(bus.of('approval').map((e) => e.approval.status)).toEqual(['pending', 'approved']);
  });

  it('denies when the judge denies, gives no verdict, or answers something else', async () => {
    for (const [verdict, reason] of [
      [{ status: 'done', result: { approve: false, reason: 'outside the notes' } }, 'outside the notes'],
      [{ status: 'cancelled' }, 'the judge rules/judge gave no verdict (it ended cancelled)'],
      [{ status: 'done', result: 'yes' }, 'the judge rules/judge answered something other than a verdict'],
    ] as const) {
      const { store, policies } = await decided({ verdict });
      await store.table('policies').insert(judgePolicy());
      const asked = await policies.decide(ask);
      if (asked.effect !== 'ask') throw new Error('expected ask');
      await settle();
      expect(await store.table('approvals').get(asked.approval.id)).toMatchObject({ status: 'denied', decisions: [{ approve: false, reason }] });
    }
  });

  it('lets the hub decide by its quota: allowed while the turn has budget left, refused once it is used up', async () => {
    for (const [left, status] of [[0.5, 'approved'], [0, 'denied']] as const) {
      const { store, policies, judged } = await decided({ left });
      await store.table('policies').insert(hubPolicy());
      const asked = await policies.decide(ask);
      if (asked.effect !== 'ask') throw new Error('expected ask');
      await settle();
      expect(await store.table('approvals').get(asked.approval.id)).toMatchObject({ status, decisions: [{ by: HUB }] });
      expect(judged).toEqual([]);
    }
  });

  it('leaves the approval waiting, and logs why, when there is no hub actor to decide as', async () => {
    const { store, policies } = await decided({ left: 1 });
    await store.table('actors').remove(HUB);
    await store.table('policies').insert(hubPolicy());
    const asked = await policies.decide(ask);
    if (asked.effect !== 'ask') throw new Error('expected ask');
    await settle();
    // the decision could not be recorded as anyone, so the approval is left pending and the failure logged
    expect((await store.table('approvals').get(asked.approval.id))?.status).toBe('pending');
  });
});

function runRow(record: FnRecord) {
  return {
    id: RUN, fn: record.name, fnVersion: 'v1', kind: record.decl.kind, system: record.system, root: RUN, turn: TRN, session: SESSION, key: 'k', actor: ALICE, caller: BOB,
    args: {}, status: 'awaiting-approval' as const, allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: 'interactive' as const,
    background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
  };
}
