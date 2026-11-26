/**
 * Keeping one case from changing another's world. A rep's cases share one hub, a few at a time, and some cases change
 * the household on purpose (turn a kid's login off, set a budget, restrict a member) while an agent may change it
 * unasked (iteration 6: case 47 turned off every account it found, so case 49's person was gone before it signed in:
 * "the runner failed: user not found"). So:
 *
 * - **Household cases play alone** (`Case.household`): a case that changes accounts, rules or budgets waits until no
 *   other case is playing, and no case starts while it plays (`CaseGate`).
 * - **The household is put back after every case** (`HouseholdKeeper.restore`), from what it was when the rep was set
 *   up (`HouseholdKeeper.snapshot`): every account the rep made is enabled again with its role (the kids' logins, each
 *   case's own person, the members made for a case once that case is over), the sign-in policy is as it was, and every
 *   rule added since (policies, budgets, priorities, model categories) is removed. A kid's login that is gone is made
 *   again. Accounts nobody made for the rep (one a case's agent added) are left as they are.
 * - Before a case's person signs in, its account is checked the same way, and made again under a new address if it
 *   still can't sign in (`Rep.person` in `rep.ts`).
 */
import type { ActorId, BudgetView, ModelCategory, PersonView, Policy, PriorityRule, RuleRef, SignInPolicy, UserRole } from '@harness/core';

/** The admin calls keeping the household needs (the rep's admin client, or a fake in tests). */
export interface HouseholdAdmin {
  people(): Promise<PersonView[]>;
  rules(): Promise<{ policies: Policy[]; budgets: BudgetView[]; priorities: PriorityRule[]; categories: ModelCategory[] }>;
  signInPolicy(): Promise<SignInPolicy>;
  updateUser(change: { user: ActorId; role?: UserRole; disabled?: boolean }): Promise<void>;
  removeRule(rule: RuleRef): Promise<void>;
  setSignInPolicy(policy: SignInPolicy): Promise<void>;
}

/** An account the rep made, and what it should be between cases. */
export interface KeptAccount {
  readonly id: ActorId;
  readonly email: string;
  readonly role: UserRole;
  /** The case it was made for (its own person, or a member it signs in as); absent: the household's (the kids'). */
  readonly owner?: number;
  /** Whether it is that case's own person (always put back, even while its case plays). */
  readonly person?: boolean;
}

/** What the household was when the rep was set up. */
export interface HouseholdSnapshot {
  readonly policy: SignInPolicy;
  /** Every rule there was, as `kind:id`. */
  readonly rules: ReadonlySet<string>;
}

/** What one restore put back, for the rep's log. */
export interface Restored {
  readonly accounts: string[];
  readonly rules: string[];
  readonly policy: boolean;
  /** Kept accounts the hub no longer has, by email (a kid's is made again by the caller). */
  readonly missing: string[];
}

/** Every rule of the hub, as `RuleRef`s. */
function refsOf(rules: Awaited<ReturnType<HouseholdAdmin['rules']>>): RuleRef[] {
  return [
    ...rules.policies.map((rule): RuleRef => ({ kind: 'policy', id: rule.id })),
    ...rules.budgets.map((rule): RuleRef => ({ kind: 'budget', id: rule.id })),
    ...rules.priorities.map((rule): RuleRef => ({ kind: 'priority', id: rule.id })),
    ...rules.categories.map((rule): RuleRef => ({ kind: 'category', id: rule.id })),
  ];
}

const keyOf = (rule: RuleRef): string => `${rule.kind}:${rule.id}`;

/** The accounts a rep made and the household it set up, put back between cases. */
export class HouseholdKeeper {
  readonly #admin: HouseholdAdmin;
  readonly #accounts = new Map<ActorId, KeptAccount>();
  #snapshot: HouseholdSnapshot | undefined;

  constructor(admin: HouseholdAdmin) {
    this.#admin = admin;
  }

  /** Keep an account the rep made. */
  keep(account: KeptAccount): void {
    this.#accounts.set(account.id, account);
  }

  /** Stop keeping an account (one made again under a new id). */
  forget(id: ActorId): void {
    this.#accounts.delete(id);
  }

  /** The kept accounts. */
  accounts(): KeptAccount[] {
    return [...this.#accounts.values()];
  }

  /** Remember the household as it is now: the sign-in policy and every rule. */
  async snapshot(): Promise<HouseholdSnapshot> {
    const [policy, rules] = await Promise.all([this.#admin.signInPolicy(), this.#admin.rules()]);
    this.#snapshot = { policy, rules: new Set(refsOf(rules).map(keyOf)) };
    return this.#snapshot;
  }

  /**
   * Put the household back as the snapshot had it. `playing` are the cases still playing: the members made for them
   * are theirs to change and stay as they are (their own person is put back all the same: no case turns its own
   * person off). Never throws for one account or rule: what fails is left and the rest goes on.
   */
  async restore(playing: ReadonlySet<number> = new Set()): Promise<Restored> {
    const snapshot = this.#snapshot;
    const done: Restored = { accounts: [], rules: [], policy: false, missing: [] };
    const people = new Map((await this.#admin.people()).map((person) => [person.id, person]));
    for (const account of this.#accounts.values()) {
      if (account.owner !== undefined && account.person !== true && playing.has(account.owner)) { continue; }
      const now = people.get(account.id);
      if (now === undefined) { done.missing.push(account.email); continue; }
      const change = { user: account.id, ...(now.disabled ? { disabled: false } : {}), ...(now.role === account.role ? {} : { role: account.role }) };
      if (Object.keys(change).length === 1) { continue; }
      try {
        await this.#admin.updateUser(change);
        done.accounts.push(`${account.email}${now.disabled ? ' turned back on' : ''}${now.role === account.role ? '' : ` made ${account.role} again`}`);
      } catch { /* left as it is; the next restore tries again */ }
    }
    if (snapshot === undefined) { return done; }
    for (const rule of refsOf(await this.#admin.rules())) {
      if (snapshot.rules.has(keyOf(rule))) { continue; }
      try {
        await this.#admin.removeRule(rule);
        done.rules.push(keyOf(rule));
      } catch { /* left; tried again next time */ }
    }
    const policy = await this.#admin.signInPolicy();
    if (JSON.stringify(policy) !== JSON.stringify(snapshot.policy)) {
      try {
        await this.#admin.setSignInPolicy(snapshot.policy);
        return { ...done, policy: true };
      } catch { /* left */ }
    }
    return done;
  }
}

/** Whether a restore put anything back. */
export function restoredAnything(restored: Restored): boolean {
  return restored.accounts.length > 0 || restored.rules.length > 0 || restored.policy || restored.missing.length > 0;
}

/** A restore in one line. */
export function restoredLine(restored: Restored): string {
  return [
    ...(restored.accounts.length === 0 ? [] : [`accounts: ${restored.accounts.join(', ')}`]),
    ...(restored.rules.length === 0 ? [] : [`removed rules: ${restored.rules.join(', ')}`]),
    ...(restored.policy ? ['sign-in policy put back'] : []),
    ...(restored.missing.length === 0 ? [] : [`gone: ${restored.missing.join(', ')}`]),
  ].join('; ');
}

/**
 * Who may play now: any number of ordinary cases together, or one household case alone. A household case that is
 * waiting goes before ordinary cases that come after it, so it is never starved.
 */
export class CaseGate {
  #playing = 0;
  #alone = false;
  #waitingAlone = 0;
  readonly #wakers: Array<() => void> = [];

  /** Wait for a turn; returns the release. */
  async enter(alone: boolean): Promise<() => void> {
    if (alone) { this.#waitingAlone++; }
    while (alone ? this.#alone || this.#playing > 0 : this.#alone || this.#waitingAlone > 0) {
      await new Promise<void>((wake) => { this.#wakers.push(wake); });
    }
    if (alone) {
      this.#waitingAlone--;
      this.#alone = true;
    } else {
      this.#playing++;
    }
    let released = false;
    return () => {
      if (released) { return; }
      released = true;
      if (alone) { this.#alone = false; } else { this.#playing--; }
      for (const wake of this.#wakers.splice(0)) { wake(); }
    };
  }
}
