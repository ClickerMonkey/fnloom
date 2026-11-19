/**
 * Who a sign-in through an SSO provider is, as Phil decided (`core/sso.ts`):
 *
 * - **Linking.** An `ExternalIdentity` (issuer, subject) signed in before is that person. Otherwise a person with the
 *   same email is linked, only when the provider says the email is verified (`verifiedEmailOf`). An unverified email
 *   that someone here already has is refused, never joined.
 * - **First sign-in.** Nobody to link makes an account only as the admin's `SignInPolicy` allows (invite only, email
 *   domains, anyone), and only with a verified email.
 * - **Roles and groups** come from the claims (`SsoClaimMap`) at every sign-in. The bootstrap (break-glass) admin
 *   always stays an admin.
 *
 * `plan` says what a sign-in would do without changing anything (a test sign-in shows it); `apply` does it, in the
 * caller's transaction. Every lookup is a keyed or indexed read: nothing is loaded to be searched.
 */
import { verifiedEmailOf } from '@ayepi/auth/oauth';
import {
  DEFAULT_SIGN_IN_POLICY, managesRole, mintId, SIGN_IN_POLICY_OPTION, UserView,
  type ActorId, type ExternalIdentity, type GroupActor, type IdentityProviderConfig, type IdRandom, type Json, type SignInPolicy, type SsoOutcome, type UserActor, type UserRole,
} from '@harness/core';
import { GROUP_COLUMNS, USER_COLUMNS } from '../query/columns.ts';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../store/rows.ts';

/** What a provider said about the person: the verified ID token's claims, with userinfo's where it adds any. */
export interface ExternalClaims {
  readonly provider: IdentityProviderConfig;
  /** The issuer as its discovery says it (the ID token's `iss`). */
  readonly issuer: string;
  readonly sub: string;
  readonly claims: Readonly<Record<string, Json>>;
}

/** What a sign-in will do, with what applying it needs. */
export interface SignInPlan extends SsoOutcome {
  readonly claims: ExternalClaims;
  /** The verified email, when the provider vouched for one. */
  readonly email: string | undefined;
  /** The person it signs in as, when one exists already. */
  readonly existing: UserActor | undefined;
  /** The identity row, when this account signed in before. */
  readonly identity: ExternalIdentity | undefined;
  /** The hub groups the claims name, by id. */
  readonly groupIds: readonly ActorId[];
  /** The name a new account gets. */
  readonly name: string;
}

/** An email as the hub keeps and compares it: trimmed, lower case. */
export const normalEmail = (email: string): string => email.trim().toLowerCase();

/** The person with this email (in any case), read in SQL; undefined when none has it. */
export async function findUserByEmail(store: HubStore, email: string): Promise<UserActor | undefined> {
  const found = await store.lists.find({
    table: 'actors', fields: USER_COLUMNS, sort: [], offset: 0, limit: 1,
    filters: [{ field: 'kind', op: 'is', value: 'user' }, { field: 'email', op: 'is', value: normalEmail(email) }],
  });
  const row = found.items[0];
  return row?.kind === 'user' ? row : undefined;
}

/** The first-sign-in policy: the admin's, else invite only. */
export async function signInPolicy(store: HubStore): Promise<SignInPolicy> {
  const row = await store.table('hubOptions').get(SIGN_IN_POLICY_OPTION);
  return row?.key === SIGN_IN_POLICY_OPTION ? row.value : DEFAULT_SIGN_IN_POLICY;
}

/**
 * The bootstrap admin: the first account made with a password (the setup page or `HARNESS_ADMIN_*`). Once SSO is
 * configured it is the only one that signs in with a password, as a break-glass login.
 */
export async function breakGlassAdmin(store: HubStore): Promise<UserActor | undefined> {
  const { items } = await store.table('credentials').find({ where: { kind: 'password' }, order: [['createdAt', 'asc']], limit: 1 });
  const first = items[0];
  const actor = first === undefined ? undefined : await store.table('actors').get(first.user);
  return actor?.kind === 'user' ? actor : undefined;
}

/** A claim's values as text: a string, or the strings of a list (other values are left out). */
export function claimValues(value: Json | undefined): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item !== '');
  return [];
}

/** Links sign-ins to people, makes accounts, and syncs roles and groups. */
export class IdentityLinker {
  readonly #clock: () => number;
  readonly #random: IdRandom | undefined;

  constructor(clock: () => number, random?: IdRandom) {
    this.#clock = clock;
    this.#random = random;
  }

  /** What signing in with these claims does: who, with which role and groups, or why it is refused. Changes nothing. */
  async plan(store: HubStore, claims: ExternalClaims): Promise<SignInPlan> {
    const { provider } = claims;
    const map = provider.claims;
    const email = emailOf(claims.claims, true);
    const given = emailOf(claims.claims, false);
    const groupNames = map.groups === undefined ? [] : [...new Set(claimValues(claims.claims[map.groups]))];
    const groups = groupNames.length === 0 ? [] : await this.#groupsNamed(store, groupNames);
    const known = new Set(groups.map((g) => g.name));
    const base = {
      claims, email, groupIds: groups.map((g) => g.id), groups: groups.map((g) => g.name), unknownGroups: groupNames.filter((n) => !known.has(n)),
      name: nameOf(claims.claims, email ?? given),
    };
    const refuse = (reason: string, existing?: UserActor, identity?: ExternalIdentity): SignInPlan => ({
      ...base, allowed: false, reason, link: existing === undefined ? 'none' : identity === undefined ? 'email' : 'linked', existing, identity,
      ...(existing === undefined ? {} : { user: UserView.parse(existing) }),
    });

    const identity = await store.table('externalIdentities').get({ issuer: claims.issuer, sub: claims.sub });
    const linked = identity === undefined ? undefined : await store.table('actors').get(identity.user);
    let existing = linked?.kind === 'user' ? linked : undefined;
    let link: SsoOutcome['link'] = 'linked';
    if (existing === undefined) {
      link = 'email';
      existing = email === undefined ? undefined : await findUserByEmail(store, email);
      if (existing === undefined && given !== undefined && (await findUserByEmail(store, given)) !== undefined) {
        return refuse(`Someone here already uses ${given}, but ${provider.label} didn't say that email is verified, so the accounts can't be joined.`);
      }
    }
    const keptIdentity = existing === undefined || link !== 'linked' ? undefined : identity;
    if (existing?.disabled === true) return refuse(`${existing.name}'s account is turned off. Ask an admin to turn it back on.`, existing, keptIdentity);

    if (existing === undefined) {
      link = 'new';
      if (email === undefined) return refuse(`${provider.label} didn't share a verified email, which a new account needs.`);
      const policy = await signInPolicy(store);
      const refusal = policyRefusal(policy, email);
      if (refusal !== undefined) return refuse(refusal);
    }

    const breakGlass = existing === undefined ? undefined : await breakGlassAdmin(store);
    const role = roleOf(map, claims.claims, existing, existing !== undefined && breakGlass?.id === existing.id);
    if (role === undefined) return refuse(`Your ${provider.label} account isn't in a group that may sign in here.`, existing, keptIdentity);
    const who = existing?.name ?? base.name;
    const reason = link === 'linked' ? `Signs in as ${who}, linked before.`
      : link === 'email' ? `Signs in as ${who}, joined by the verified email ${email ?? ''}.`
      : `Makes a new account for ${who} (${email ?? ''}).`;
    return { ...base, allowed: true, reason, link, role, existing, identity: keptIdentity, ...(existing === undefined ? {} : { user: UserView.parse(existing) }) };
  }

  /** Do an allowed plan in `store` (a transaction): make or update the person, link the identity, sync groups. */
  async apply(store: HubStore, plan: SignInPlan): Promise<UserActor> {
    if (!plan.allowed || plan.role === undefined) throw new Error(`a refused sign-in can't be applied: ${plan.reason}`);
    const now = this.#clock();
    const { claims } = plan;
    let user = plan.existing;
    if (user === undefined) {
      if (plan.email === undefined) throw new Error('a new account needs a verified email');
      user = { id: mintId('actor', this.#random), kind: 'user', name: plan.name, about: '', email: plan.email, role: plan.role, createdAt: now, disabled: false };
      await store.table('actors').insert(user);
    } else if (user.role !== plan.role) {
      const updated = await store.table('actors').update(user.id, { role: plan.role });
      user = updated.kind === 'user' ? updated : user;
    }
    await store.table('externalIdentities').put({
      issuer: claims.issuer, sub: claims.sub, provider: claims.provider.id, user: user.id, ...(plan.email === undefined ? {} : { email: plan.email }),
      linkedAt: plan.identity?.user === user.id ? plan.identity.linkedAt : now, lastSignInAt: now,
    });
    await this.#syncGroups(store, user.id, claims.provider.id, plan.groupIds, now);
    return user;
  }

  /** Put the person in the claims' groups, and take them out of the ones this provider put them in that the claims dropped. */
  async #syncGroups(store: HubStore, user: ActorId, provider: string, groups: readonly ActorId[], now: number): Promise<void> {
    const memberships = store.table('memberships');
    const current = await allRows(memberships, { where: { user } });
    const wanted = new Set(groups);
    for (const membership of current) {
      if (membership.provider === provider && !wanted.has(membership.group)) await memberships.remove({ group: membership.group, user });
    }
    const have = new Set(current.map((m) => m.group));
    for (const group of wanted) {
      if (!have.has(group)) await memberships.insert({ group, user, addedBy: user, addedAt: now, provider });
    }
  }

  /** The hub groups with these names, read in SQL. */
  async #groupsNamed(store: HubStore, names: readonly string[]): Promise<GroupActor[]> {
    const found = await store.lists.find({
      table: 'actors', fields: GROUP_COLUMNS, sort: [{ field: 'name', dir: 'asc' }], offset: 0, limit: names.length * 2,
      filters: [{ field: 'kind', op: 'is', value: 'group' }, { field: 'name', op: 'in', values: [...names] }],
    });
    return found.items.flatMap((row) => (row.kind === 'group' ? [row] : []));
  }
}

/** The outcome part of a plan, as the wire carries it. */
export function outcomeOf(plan: SignInPlan): SsoOutcome {
  return {
    allowed: plan.allowed, reason: plan.reason, link: plan.link, groups: [...plan.groups], unknownGroups: [...plan.unknownGroups],
    ...(plan.user === undefined ? {} : { user: plan.user }), ...(plan.role === undefined ? {} : { role: plan.role }),
  };
}

/** Why the policy refuses a new account for this verified email, or undefined when it allows one. */
export function policyRefusal(policy: SignInPolicy, email: string): string | undefined {
  switch (policy.mode) {
    case 'anyone': return undefined;
    case 'invite': return `This hub is invite only. Ask an admin to add ${email}.`;
    case 'domains': {
      const domain = email.slice(email.lastIndexOf('@') + 1);
      return policy.domains.includes(domain) ? undefined : `${domain} isn't one of the email domains that can join. Ask an admin to add you.`;
    }
  }
}

/**
 * The role a sign-in gives: the break-glass admin stays an admin; a map that manages the role picks it from the
 * claim's values (undefined: not allowed in); otherwise the person keeps theirs, and a new person is a member.
 */
export function roleOf(map: IdentityProviderConfig['claims'], claims: Readonly<Record<string, Json>>, existing: UserActor | undefined, breakGlass: boolean): UserRole | undefined {
  if (breakGlass) return 'admin';
  if (!managesRole(map)) return existing?.role ?? 'member';
  const values = new Set(claimValues(claims[map.role]));
  if (map.admin.some((value) => values.has(value))) return 'admin';
  if (map.member === undefined || map.member.some((value) => values.has(value))) return 'member';
  return undefined;
}

/** The claims' email: only a verified one when `verified`, else whatever was given. Normalised. */
function emailOf(claims: Readonly<Record<string, Json>>, verified: boolean): string | undefined {
  const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
  if (email === undefined || email.trim() === '') return undefined;
  const flag = claims['email_verified'];
  const read = verified ? verifiedEmailOf({ email, ...(typeof flag === 'boolean' || flag === 'true' || flag === 'false' ? { email_verified: flag } : {}) }) : email;
  return read === undefined ? undefined : normalEmail(read);
}

/** A new account's name: the claims' name, preferred username, or the email's local part. */
function nameOf(claims: Readonly<Record<string, Json>>, email: string | undefined): string {
  for (const key of ['name', 'preferred_username', 'given_name']) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return email === undefined ? 'New person' : (email.split('@')[0] ?? email);
}
