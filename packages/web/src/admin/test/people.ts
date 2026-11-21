/**
 * Fake People callers (SSO): two people (the break-glass admin and a member who signed in through Acme), one group,
 * one provider, and the hub's answers to checks, test sign-ins and writes, all parsed through the hub's own schemas.
 */
import { DEFAULT_PROXY_TRUST, DEFAULT_SIGN_IN_LIMITS, GroupView, PersonView, ProxyTrust, SignInLimits, SignInPolicy, SignInSettings, SsoCheck, SsoTestResult, UserView } from '@harness/core';
import { ApiError } from '@ayepi/core/client';
import { fakeCaller } from '../../test/fakes.ts';
import { T0 } from '../../test/clock.ts';

/** The break-glass admin. */
export const ADA = PersonView.parse({
  id: 'act_ada', kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'admin', disabled: false, createdAt: T0, breakGlass: true, password: true, identities: [], groups: [],
});

/** A member who signed in through Acme, synced into Finance. */
export const BO = PersonView.parse({
  id: 'act_bo', kind: 'user', name: 'Bo', email: 'bo@example.com', role: 'member', disabled: false, createdAt: T0 + 1, breakGlass: false, password: false,
  identities: [{ provider: 'acme', label: 'Acme', email: 'bo@example.com', lastSignInAt: T0 + 2 }], groups: [{ id: 'act_finance', name: 'Finance', synced: true }],
});

export const FINANCE = GroupView.parse({ id: 'act_finance', name: 'Finance', about: 'The money people.', createdAt: T0, members: 1 });

/** The sign-in settings: one provider, invite only. */
export function signInSettings(policy: SignInPolicy = { mode: 'invite' }): SignInSettings {
  return SignInSettings.parse({
    providers: [{ id: 'acme', label: 'Acme', issuer: 'https://id.acme.test', clientId: 'harness', scope: 'openid email profile', userinfo: true, claims: { role: 'groups', admin: ['admins'], groups: 'groups' }, confidential: true }],
    policy, breakGlass: UserView.parse(ADA), callbackUrl: 'https://hub.test/auth/sso/callback', limits: DEFAULT_SIGN_IN_LIMITS, proxy: DEFAULT_PROXY_TRUST,
  });
}

/** A test sign-in the policy would refuse. */
export const TEST_RESULT = SsoTestResult.parse({
  id: 'tst_1', provider: 'acme', at: T0, subject: 'cy-1', email: 'cy@example.com', emailVerified: true, claims: { email: 'cy@example.com', groups: ['Nope'] },
  outcome: { allowed: false, reason: 'This hub is invite only. Ask an admin to add cy@example.com.', link: 'none', groups: [], unknownGroups: ['Nope'] },
});

/** The People callers. */
export function fakePeopleApi() {
  return {
    people: fakeCaller<'people'>((query) => Promise.resolve({ items: [ADA, BO].filter((p) => query?.filters === undefined || query.filters.some((f) => f.op === 'is' && f.value === p.email)) })),
    groups: fakeCaller<'groups'>(() => Promise.resolve({ items: [FINANCE] })),
    groupMembers: fakeCaller<'groupMembers'>(() => Promise.resolve({ group: FINANCE, items: [UserView.parse(BO)] })),
    addUser: fakeCaller<'addUser'>(() => Promise.resolve({ id: 'act_cy' })),
    addGroup: fakeCaller<'addGroup'>(() => Promise.resolve({ id: 'act_ops' })),
    updateUser: fakeCaller<'updateUser'>(({ user }) => (user === ADA.id ? Promise.reject(new ApiError(409, 'BREAK_GLASS', 'Ada is the break-glass admin, who always stays an admin and can always sign in.')) : Promise.resolve({ id: user }))),
    setMembership: fakeCaller<'setMembership'>(() => Promise.resolve({ ok: true })),
    signInSettings: fakeCaller<'signInSettings'>(() => Promise.resolve(signInSettings())),
    setSignInPolicy: fakeCaller<'setSignInPolicy'>((policy) => Promise.resolve(SignInPolicy.parse(policy))),
    setSignInLimits: fakeCaller<'setSignInLimits'>((limits) => Promise.resolve(SignInLimits.parse(limits))),
    setProxyTrust: fakeCaller<'setProxyTrust'>((trust) => Promise.resolve(ProxyTrust.parse(trust))),
    checkSsoProvider: fakeCaller<'checkSsoProvider'>(({ provider }) => Promise.resolve(SsoCheck.parse({
      provider, ok: true, discovery: { ok: true, detail: 'Found https://id.acme.test.' }, keys: { ok: true, detail: '2 signing keys.' }, checkedAt: T0,
    }))),
    testSsoSignIn: fakeCaller<'testSsoSignIn'>(() => Promise.resolve({ url: 'https://id.acme.test/authorize?state=s', test: 'tst_1' })),
    ssoTestResult: fakeCaller<'ssoTestResult'>(() => Promise.resolve(TEST_RESULT)),
  };
}
