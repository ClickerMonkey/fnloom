/** One case never changes another's world (`household.ts`): the household put back between cases, household cases alone. */
import type { ActorId, BudgetView, PersonView, Policy, RuleRef, SignInPolicy, UserRole } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { CaseGate, HouseholdKeeper, restoredAnything, restoredLine, type HouseholdAdmin } from './household.ts';

const id = (name: string): ActorId => `act_${name}` as ActorId;

/** A hub's people and rules in memory, changed the way the admin endpoints change them. */
class FakeHub implements HouseholdAdmin {
  readonly people$ = new Map<ActorId, PersonView>();
  policies: Policy[] = [];
  budgets: BudgetView[] = [];
  policy: SignInPolicy = { mode: 'invite' };
  readonly calls: string[] = [];

  add(name: string, role: UserRole): ActorId {
    const user = id(name);
    this.people$.set(user, { id: user, kind: 'user', name, email: `${name}@home.test`, role, disabled: false, createdAt: 0, breakGlass: false, password: true, identities: [], groups: [] } as unknown as PersonView);
    return user;
  }

  people(): Promise<PersonView[]> { return Promise.resolve([...this.people$.values()]); }
  rules(): ReturnType<HouseholdAdmin['rules']> { return Promise.resolve({ policies: this.policies, budgets: this.budgets, priorities: [], categories: [] }); }
  signInPolicy(): Promise<SignInPolicy> { return Promise.resolve(this.policy); }

  updateUser(change: { user: ActorId; role?: UserRole; disabled?: boolean }): Promise<void> {
    this.calls.push(`update ${change.user}`);
    const person = this.people$.get(change.user);
    if (person !== undefined) { this.people$.set(change.user, { ...person, ...(change.role === undefined ? {} : { role: change.role }), ...(change.disabled === undefined ? {} : { disabled: change.disabled }) }); }
    return Promise.resolve();
  }

  removeRule(rule: RuleRef): Promise<void> {
    this.calls.push(`remove ${rule.kind}:${rule.id}`);
    if (rule.kind === 'policy') { this.policies = this.policies.filter((p) => p.id !== rule.id); }
    if (rule.kind === 'budget') { this.budgets = this.budgets.filter((b) => b.id !== rule.id); }
    return Promise.resolve();
  }

  setSignInPolicy(policy: SignInPolicy): Promise<void> {
    this.calls.push('policy');
    this.policy = policy;
    return Promise.resolve();
  }
}

describe('putting the household back between cases', () => {
  it('turns the rep\'s accounts back on with their roles, removes rules added since, and puts the sign-in policy back', async () => {
    const hub = new FakeHub();
    hub.policies = [{ id: 'pol_setup' } as unknown as Policy];
    const keeper = new HouseholdKeeper(hub);
    const leo = hub.add('leo', 'member');
    const case49 = hub.add('case-49', 'admin');
    keeper.keep({ id: leo, email: 'leo@home.test', role: 'member' });
    keeper.keep({ id: case49, email: 'case-49@home.test', role: 'admin', owner: 49, person: true });
    await keeper.snapshot();
    // what one case's agent did: Leo and another case's person off, a role changed, a rule and a budget added, sign-up opened
    await hub.updateUser({ user: leo, disabled: true });
    await hub.updateUser({ user: case49, disabled: true, role: 'member' });
    hub.policies.push({ id: 'pol_new' } as unknown as Policy);
    hub.budgets.push({ id: 'bud_new' } as unknown as BudgetView);
    hub.policy = { mode: 'anyone' };
    const untracked = hub.add('someone-added', 'member');
    await hub.updateUser({ user: untracked, disabled: true });
    hub.calls.length = 0;

    const restored = await keeper.restore();
    expect(hub.people$.get(leo)).toMatchObject({ disabled: false, role: 'member' });
    expect(hub.people$.get(case49)).toMatchObject({ disabled: false, role: 'admin' });
    // an account the rep didn't make is left as the case left it
    expect(hub.people$.get(untracked)).toMatchObject({ disabled: true });
    expect(hub.policies.map((p) => p.id)).toEqual(['pol_setup']);
    expect(hub.budgets).toEqual([]);
    expect(hub.policy).toEqual({ mode: 'invite' });
    expect(restoredAnything(restored)).toBe(true);
    expect(restoredLine(restored)).toBe('accounts: leo@home.test turned back on, case-49@home.test turned back on made admin again; removed rules: policy:pol_new, budget:bud_new; sign-in policy put back');
    // nothing to do the second time
    hub.calls.length = 0;
    expect(restoredAnything(await keeper.restore())).toBe(false);
    expect(hub.calls).toEqual([]);
  });

  it('leaves a playing case\'s own members to it, but always puts its person back, and says what is gone', async () => {
    const hub = new FakeHub();
    const keeper = new HouseholdKeeper(hub);
    const person = hub.add('case-45', 'admin');
    const sara = hub.add('case-45-sara', 'member');
    keeper.keep({ id: person, email: 'case-45@home.test', role: 'admin', owner: 45, person: true });
    keeper.keep({ id: sara, email: 'case-45-sara@home.test', role: 'member', owner: 45 });
    keeper.keep({ id: id('gone'), email: 'gone@home.test', role: 'member' });
    await keeper.snapshot();
    await hub.updateUser({ user: person, disabled: true });
    await hub.updateUser({ user: sara, disabled: true });
    const restored = await keeper.restore(new Set([45]));
    expect(hub.people$.get(person)?.disabled).toBe(false);
    expect(hub.people$.get(sara)?.disabled).toBe(true);
    expect(restored.missing).toEqual(['gone@home.test']);
    await keeper.restore(new Set());
    expect(hub.people$.get(sara)?.disabled).toBe(false);
  });
});

describe('who plays when', () => {
  it('lets ordinary cases play together and a household case only alone, before ordinary cases that come after it', async () => {
    const gate = new CaseGate();
    const order: string[] = [];
    const a = await gate.enter(false);
    const b = await gate.enter(false);
    order.push('a', 'b');
    const household = gate.enter(true).then((release) => { order.push('household'); return release; });
    const later = gate.enter(false).then((release) => { order.push('later'); return release; });
    await new Promise((done) => { setTimeout(done, 5); });
    expect(order).toEqual(['a', 'b']);
    a();
    await new Promise((done) => { setTimeout(done, 5); });
    expect(order).toEqual(['a', 'b']);
    b();
    const alone = await household;
    await new Promise((done) => { setTimeout(done, 5); });
    expect(order).toEqual(['a', 'b', 'household']);
    alone();
    (await later)();
    expect(order).toEqual(['a', 'b', 'household', 'later']);
  });
});
