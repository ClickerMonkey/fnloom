/**
 * SSO end to end against a fake OpenID provider (`testing/issuer.ts`): the real start and callback route on a real
 * HTTP server, the real `OidcSignIns` and `HubAuthenticator` on a real store, and the web API for the hand-over
 * (`refresh`) and the People endpoints. Covers the callback with a fake issuer, the linking rules, the first-sign-in
 * policy, claim re-sync, test sign-ins and provider checks.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ActorId, IdentityProviderConfigs, SSO_HANDOFF_COOKIE, SSO_HANDOFF_KEY, type SignInPolicy, type Tokens } from '@harness/core';
import { FakeIssuer, type FakeAccount } from './testing/issuer.ts';
import { rig, testSettings, webRig, type Rig, type WebRig } from './testing/rig.ts';
import { SsoRoute } from './sso-route.ts';
import { HANDOFF_TTL, SSO_COOKIE, SSO_REDEEM_PATH } from './sso.ts';

let server: Server | undefined;
afterEach(async () => { await new Promise((done) => { if (server === undefined) { done(undefined); } else { server.close(done); } }); server = undefined; });

const ADMINS = 'harness-admins';
const MEMBERS = 'harness-people';

/** A hub with one provider (`acme`, the fake issuer), its web API, and the SSO routes on a real port, which is `HARNESS_URL`. */
async function hubWithSso(claims: Partial<{ member: string[] }> = {}) {
  const clock: { rig?: Rig } = {};
  const issuer = new FakeIssuer({ now: () => clock.rig?.now ?? 0 });
  const routes: { route?: SsoRoute } = {};
  server = createServer((req, res) => {
    const route = routes.route;
    if (route === undefined) { res.writeHead(503).end(); return; }
    void route.serve(req, res, new URL(req.url ?? '/', 'http://hub').pathname).then((served) => { if (!served) res.writeHead(404).end(); });
  });
  await new Promise<void>((done) => { server?.listen(0, '127.0.0.1', done); });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? (address satisfies AddressInfo).port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const base = testSettings();
  const providers = IdentityProviderConfigs.parse([{
    id: 'acme', label: 'Acme', issuer: issuer.issuer, clientId: issuer.clientId, clientSecret: issuer.clientSecret,
    claims: { role: 'roles', admin: [ADMINS], groups: 'groups', ...claims },
  }]);
  const r = await rig({}, { ...base, hubEnv: { ...base.hubEnv, HARNESS_URL: origin }, authEnv: { ...base.authEnv, HARNESS_SSO_PROVIDERS: providers } }, { oidcFetch: issuer.fetch });
  clock.rig = r;
  const web = await webRig(r);
  const owner = await web.admin();
  routes.route = new SsoRoute(() => r.api.sso);
  /** A GET on the hub's port; `headers` as a proxy in front would add them (`x-forwarded-host`). */
  const get = (path: string, cookie?: string, headers: Readonly<Record<string, string>> = {}) =>
    fetch(`${origin}${path}`, { redirect: 'manual', headers: { ...headers, ...(cookie === undefined ? {} : { cookie }) } });
  return { r, web, owner, issuer, get, origin };
}

type Hub = Awaited<ReturnType<typeof hubWithSso>>;

/** The cookie a start set, as the browser sends it back. */
function cookieOf(response: Response): string {
  const set = response.headers.get('set-cookie') ?? '';
  return set.split(';')[0] ?? '';
}

/** Sign in through the provider as `account` (from `startPath`, the sign-in page's link by default): the callback's redirect location. */
async function signIn(hub: Hub, account: FakeAccount, next = '/chat', startPath = `/auth/sso/acme/start?next=${encodeURIComponent(next)}`): Promise<string> {
  const start = await hub.get(startPath);
  expect(start.status).toBe(302);
  const back = hub.issuer.authorize(start.headers.get('location') ?? '', account);
  const done = await hub.get(`/auth/sso/callback?${back.toString()}`, cookieOf(start));
  expect(done.headers.get('set-cookie')).toContain(`${SSO_COOKIE}=; Path=/auth/sso/callback; Max-Age=0`);
  const location = done.headers.get('location') ?? '';
  const handoff = done.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SSO_HANDOFF_COOKIE}=`));
  if (handoff !== undefined) {
    expect(handoff).toContain(`Path=${SSO_REDEEM_PATH}`);
    expect(handoff).toContain('HttpOnly');
    handoffs.set(location, handoff.split(';')[0] ?? '');
  }
  return location;
}

/** The hand-off cookie each finished sign-in set, by the location it sent the browser to (the browser that finished it). */
const handoffs = new Map<string, string>();

/** The hand-off code a successful callback's location carries in its fragment. */
function codeIn(location: string): string {
  const code = new URLSearchParams(location.slice(location.indexOf('#') + 1)).get(SSO_HANDOFF_KEY);
  if (code === null) throw new Error(`no hand-off in ${location}`);
  return code;
}

/**
 * The tokens the sign-in page gets for a successful callback's location: the code in the fragment, redeemed with
 * the hand-off cookie of the browser it finished in (`cookie` for another browser's, or `null` for none).
 */
async function handedOver(web: WebRig, location: string, cookie: string | null | undefined = handoffs.get(location)): Promise<Tokens> {
  return web.client.call('redeemSso', { code: codeIn(location) }, cookie === null || cookie === undefined ? {} : { headers: { cookie } });
}

/** The problem a redirect to the sign-in page carries. */
function problemIn(location: string): string | null {
  return new URL(location, 'http://hub').searchParams.get('problem');
}

async function setPolicy(hub: Hub, policy: SignInPolicy): Promise<void> {
  await hub.web.client.call('setSignInPolicy', policy, hub.web.as(hub.owner));
}

const ann: FakeAccount = { sub: 'ann-1', claims: { email: 'Ann@Example.com', email_verified: true, name: 'Ann Lee' } };

describe('SSO sign-in through an OpenID provider', () => {
  it('starts with a bound, signed cookie and sends the person to the provider with PKCE, state and nonce', async () => {
    const hub = await hubWithSso();
    const start = await hub.get('/auth/sso/acme/start?next=%2Fchat');
    const url = new URL(start.headers.get('location') ?? '');
    expect(url.origin + url.pathname).toBe(`${hub.issuer.issuer}/authorize`);
    expect(Object.fromEntries([...url.searchParams.keys()].map((k) => [k, true]))).toMatchObject({ state: true, nonce: true, code_challenge: true, client_id: true, redirect_uri: true });
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`${hub.r.hub.settings.hubEnv.HARNESS_URL}/auth/sso/callback`);
    const cookie = start.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^harness_sso=[^;]+; Path=\/auth\/sso\/callback; Max-Age=600; HttpOnly; SameSite=Lax$/);
    // the PKCE verifier never travels through the provider
    expect(start.headers.get('location')).not.toContain(decodeURIComponent(cookie.split(';')[0]?.split('=')[1] ?? '').split('.')[0]);
    expect(problemIn((await hub.get('/auth/sso/nobody/start')).headers.get('location') ?? '')).toBe('That sign-in option isn\'t available.');
  });

  it('bounces a start reached at another host (the LAN IP, the web dev port) to the same start on HARNESS_URL, next kept', async () => {
    const hub = await hubWithSso();
    const lan = await hub.get('/auth/sso/acme/start?next=%2Fchat%2Fabc%3Fq%3D1', undefined, { 'x-forwarded-host': '192.168.22.111:5173' });
    expect(lan.status).toBe(302);
    // no binding cookie on the other origin: the provider never comes back there
    expect(lan.headers.get('set-cookie')).toBeNull();
    const there = new URL(lan.headers.get('location') ?? '');
    expect(there.origin + there.pathname).toBe(`${hub.origin}/auth/sso/acme/start`);
    expect(there.searchParams.get('next')).toBe('/chat/abc?q=1');
    // a next that would leave the app is dropped on the way, as the start itself would
    const away = new URL((await hub.get('/auth/sso/acme/start?next=%2F%2Fevil.test', undefined, { 'x-forwarded-host': '192.168.22.111' })).headers.get('location') ?? '');
    expect(away.origin + away.pathname).toBe(`${hub.origin}/auth/sso/acme/start`);
    expect(away.searchParams.has('next')).toBe(false);
    // the bounced start goes to the provider, and the sign-in finishes where it was going
    await setPolicy(hub, { mode: 'anyone' });
    const location = await signIn(hub, ann, '/chat/abc?q=1', `${there.pathname}${there.search}`);
    expect(location.startsWith('/sign-in?next=%2Fchat%2Fabc%3Fq%3D1#')).toBe(true);
    expect((await handedOver(hub.web, location)).user.name).toBe('Ann Lee');
  });

  it('starts at once when reached at the HARNESS_URL host, and never bounces a bounced start again', async () => {
    const hub = await hubWithSso();
    const same = await hub.get('/auth/sso/acme/start?next=%2Fchat');
    expect(new URL(same.headers.get('location') ?? '').origin).toBe(hub.issuer.issuer);
    expect(same.headers.get('set-cookie')).toContain('harness_sso=');
    // a proxy that forwards HARNESS_URL's own host is the same origin
    const proxied = await hub.get('/auth/sso/acme/start', undefined, { 'x-forwarded-host': new URL(hub.origin).host });
    expect(new URL(proxied.headers.get('location') ?? '').origin).toBe(hub.issuer.issuer);
    // a proxy that hides the host the browser used can't loop: a bounced start starts
    const again = await hub.get('/auth/sso/acme/start?next=%2Fchat&relocated=1', undefined, { 'x-forwarded-host': 'internal:8080' });
    expect(new URL(again.headers.get('location') ?? '').origin).toBe(hub.issuer.issuer);
  });

  it('makes an account for a verified email when the policy lets anyone in, and hands the session to the sign-in page', async () => {
    const hub = await hubWithSso();
    await setPolicy(hub, { mode: 'anyone' });
    const location = await signIn(hub, ann, '/chat/ses_1');
    expect(location.startsWith('/sign-in?next=%2Fchat%2Fses_1#sso=')).toBe(true);
    const tokens = await handedOver(hub.web, location);
    expect(tokens.user).toMatchObject({ name: 'Ann Lee', email: 'ann@example.com', role: 'member' });
    const identity = await hub.r.store.table('externalIdentities').get({ issuer: hub.issuer.issuer, sub: 'ann-1' });
    expect(identity).toMatchObject({ provider: 'acme', user: tokens.user.id, email: 'ann@example.com' });
    // the hand-off code is spent: it works once
    await expect(handedOver(hub.web, location)).rejects.toMatchObject({ status: 401 });
    // a second sign-in is the same person, linked
    const again = await handedOver(hub.web, await signIn(hub, ann));
    expect(again.user.id).toBe(tokens.user.id);
  });

  it('redeems a hand-off code only in the browser the sign-in finished in, once, and only for a minute (login CSRF)', async () => {
    const hub = await hubWithSso();
    await setPolicy(hub, { mode: 'anyone' });
    // Mallory signs in as herself and sends Ann her code: Ann's browser has no cookie for it, or its own for another
    const mallory: FakeAccount = { sub: 'mal-1', claims: { email: 'mallory@example.com', email_verified: true, name: 'Mallory' } };
    const hers = await signIn(hub, mallory);
    const anns = await signIn(hub, ann);
    await expect(handedOver(hub.web, hers, null)).rejects.toMatchObject({ status: 401 });
    await expect(handedOver(hub.web, hers, handoffs.get(anns))).rejects.toMatchObject({ status: 401 });
    await expect(handedOver(hub.web, hers, `${SSO_HANDOFF_COOKIE}=forged.value`)).rejects.toMatchObject({ status: 401 });
    // Ann's own code, in Ann's browser, signs Ann in, once
    await expect(handedOver(hub.web, anns)).resolves.toMatchObject({ user: { name: 'Ann Lee' } });
    await expect(handedOver(hub.web, anns)).rejects.toMatchObject({ status: 401 });
    // a code left too long stops working, even in its own browser
    const late = await signIn(hub, ann);
    hub.r.now += HANDOFF_TTL + 1;
    await expect(handedOver(hub.web, late)).rejects.toMatchObject({ status: 401 });
    // and the fragment never carries a refresh token
    expect(codeIn(late)).not.toContain('.');
  });

  it('is invite only until the admin says otherwise, and links an invited person by verified email', async () => {
    const hub = await hubWithSso();
    const refused = await signIn(hub, ann);
    expect(refused.startsWith('/sign-in?next=%2Fchat&problem=')).toBe(true);
    expect(problemIn(refused)).toBe('This hub is invite only. Ask an admin to add ann@example.com.');
    expect(await hub.r.store.table('externalIdentities').get({ issuer: hub.issuer.issuer, sub: 'ann-1' })).toBeUndefined();
    const { id } = await hub.web.client.call('addUser', { email: 'ann@example.com', name: 'Ann', role: 'member' }, hub.web.as(hub.owner));
    const tokens = await handedOver(hub.web, await signIn(hub, ann));
    expect(tokens.user).toMatchObject({ id, name: 'Ann' });
  });

  it('lets in only the allowed email domains', async () => {
    const hub = await hubWithSso();
    await setPolicy(hub, { mode: 'domains', domains: ['acme.test'] });
    expect(problemIn(await signIn(hub, ann))).toBe('example.com isn\'t one of the email domains that can join. Ask an admin to add you.');
    const bo = await handedOver(hub.web, await signIn(hub, { sub: 'bo-1', claims: { email: 'bo@acme.test', email_verified: 'true' } }));
    expect(bo.user).toMatchObject({ email: 'bo@acme.test', name: 'bo' });
  });

  it('never joins accounts on an email the provider didn\'t verify, and never makes one without a verified email', async () => {
    const hub = await hubWithSso();
    await setPolicy(hub, { mode: 'anyone' });
    // the admin's own email, unverified: refused, not joined to the admin
    const imposter = await signIn(hub, { sub: 'x-1', claims: { email: 'admin@example.com', email_verified: false } });
    expect(problemIn(imposter)).toBe('Someone here already uses admin@example.com, but Acme didn\'t say that email is verified, so the accounts can\'t be joined.');
    const anonymous = await signIn(hub, { sub: 'x-2', claims: { email: 'new@example.com' } });
    expect(problemIn(anonymous)).toBe('Acme didn\'t share a verified email, which a new account needs.');
    expect(await hub.r.store.table('actors').count({ kind: 'user' })).toBe(1);
  });

  it('maps claims to the role and groups, and syncs them again at every sign-in', async () => {
    const hub = await hubWithSso({ member: [MEMBERS] });
    await setPolicy(hub, { mode: 'anyone' });
    const as = hub.web.as(hub.owner);
    const finance = (await hub.web.client.call('addGroup', { name: 'Finance', about: '' }, as)).id;
    const ops = (await hub.web.client.call('addGroup', { name: 'Ops', about: '' }, as)).id;
    const travel = (await hub.web.client.call('addGroup', { name: 'Travel', about: '' }, as)).id;
    // groups and roles come from userinfo too
    const first = await handedOver(hub.web, await signIn(hub, { ...ann, userinfo: { roles: [ADMINS], groups: ['Finance', 'Ops', 'Nope'] } }));
    expect(first.user.role).toBe('admin');
    const groupsOf = async () => (await hub.r.store.table('memberships').find({ where: { user: first.user.id }, limit: 50 })).items.map((m) => [m.group, m.provider ?? 'admin']).sort();
    expect(await groupsOf()).toEqual([[finance, 'acme'], [ops, 'acme']].sort());
    // an admin adds her to Travel by hand: a sign-in never takes that away
    await hub.web.client.call('setMembership', { group: travel, user: first.user.id, member: true }, as);
    const second = await handedOver(hub.web, await signIn(hub, { ...ann, userinfo: { roles: [MEMBERS], groups: ['Ops'] } }));
    expect(second.user).toMatchObject({ id: first.user.id, role: 'member' });
    expect(await groupsOf()).toEqual([[ops, 'acme'], [travel, 'admin']].sort());
    // not in a role the provider lets in: refused, and she stays as she was
    const out = await signIn(hub, { ...ann, userinfo: { roles: ['contractors'], groups: [] } });
    expect(problemIn(out)).toBe('Your Acme account isn\'t in a group that may sign in here.');
    expect(await groupsOf()).toEqual([[ops, 'acme'], [travel, 'admin']].sort());
  });

  it('keeps the break-glass admin an admin whatever the claims say', async () => {
    const hub = await hubWithSso();
    const tokens = await handedOver(hub.web, await signIn(hub, { sub: 'boss', claims: { email: 'admin@example.com', email_verified: true, roles: ['nobody'] } }));
    expect(tokens.user).toMatchObject({ id: hub.owner.user.id, role: 'admin' });
  });

  it('refuses a callback without its browser\'s cookie, a provider\'s refusal, and an ID token for another client', async () => {
    const hub = await hubWithSso();
    await setPolicy(hub, { mode: 'anyone' });
    const start = await hub.get('/auth/sso/acme/start');
    const back = hub.issuer.authorize(start.headers.get('location') ?? '', ann);
    const elsewhere = await hub.get(`/auth/sso/callback?${back.toString()}`);
    expect(problemIn(elsewhere.headers.get('location') ?? '')).toBe('This sign-in has expired or was started in another browser. Sign in again.');
    // a forged cookie is no better
    const forged = await hub.get(`/auth/sso/callback?${back.toString()}`, `${SSO_COOKIE}=e30.forged`);
    expect(problemIn(forged.headers.get('location') ?? '')).toContain('expired or was started');
    // the cookie of another sign-in doesn't match this state
    const other = await hub.get('/auth/sso/acme/start');
    const mismatched = await hub.get(`/auth/sso/callback?${back.toString()}`, cookieOf(other));
    expect(problemIn(mismatched.headers.get('location') ?? '')).toBe('This sign-in link doesn\'t match the one started here. Sign in again.');

    const cancelled = await hub.get('/auth/sso/acme/start');
    const no = hub.issuer.authorize(cancelled.headers.get('location') ?? '', ann, 'access_denied');
    expect((await hub.get(`/auth/sso/callback?${no.toString()}`, cookieOf(cancelled))).headers.get('location')).toBe('/sign-in?problem=Acme+sign-in+was+cancelled.');

    hub.issuer.audience = 'someone-else';
    const wrong = await signIn(hub, ann);
    expect(problemIn(wrong)).toMatch(/^Acme sign-in failed: /);
    expect(await hub.r.store.table('externalIdentities').count()).toBe(0);
  });

  it('runs a test sign-in that signs nobody in, for its admin\'s eyes only', async () => {
    const hub = await hubWithSso();
    const as = hub.web.as(hub.owner);
    const { url, test } = await hub.web.client.call('testSsoSignIn', { provider: 'acme' }, as);
    expect(url.startsWith(`${hub.issuer.issuer}/authorize?`)).toBe(true);
    // the API set the cookie in the admin's browser; here the service's own start stands in for it
    const started = await hub.r.api.sso.start('acme', { test: { id: test, admin: hub.owner.user.id } });
    const back = hub.issuer.authorize(started.url, { ...ann, userinfo: { roles: [ADMINS], groups: ['Nope'] } });
    const done = await hub.get(`/auth/sso/callback?${back.toString()}`, `${SSO_COOKIE}=${encodeURIComponent(started.cookie.value)}`);
    expect(done.headers.get('location')).toBe(`/admin/people/sign-in?test=${test}`);
    const result = await hub.web.client.call('ssoTestResult', { test }, as);
    expect(result).toMatchObject({
      provider: 'acme', subject: 'ann-1', email: 'Ann@Example.com', emailVerified: true,
      outcome: { allowed: false, link: 'none', reason: 'This hub is invite only. Ask an admin to add ann@example.com.', unknownGroups: ['Nope'] },
    });
    expect(result.claims).toMatchObject({ roles: [ADMINS], name: 'Ann Lee' });
    expect(await hub.r.store.table('actors').count({ kind: 'user' })).toBe(1);
    // another admin can't read it
    const { id } = await hub.web.client.call('addUser', { email: 'cy@example.com', name: 'Cy', role: 'admin' }, as);
    expect(hub.r.api.sso.testResult(test, ActorId.parse(id))).toBeUndefined();
  });

  it('checks a provider\'s discovery and key set, and says what failed', async () => {
    const hub = await hubWithSso();
    const as = hub.web.as(hub.owner);
    const ok = await hub.web.client.call('checkSsoProvider', { provider: 'acme' }, as);
    expect(ok).toMatchObject({ provider: 'acme', ok: true, discovery: { ok: true }, keys: { ok: true, detail: `1 signing key at ${hub.issuer.issuer}/jwks.` } });
    hub.issuer.down = true;
    const down = await hub.web.client.call('checkSsoProvider', { provider: 'acme' }, as);
    expect(down).toMatchObject({ ok: false, discovery: { ok: false }, keys: { ok: false, detail: 'Not checked: discovery failed.' } });
    await expect(hub.web.client.call('checkSsoProvider', { provider: 'nobody' }, as)).rejects.toThrow();
  });

  it('shows the sign-in settings without the client secret, and the providers on the sign-in page', async () => {
    const hub = await hubWithSso();
    const settings = await hub.web.client.call('signInSettings', {}, hub.web.as(hub.owner));
    expect(settings).toMatchObject({ policy: { mode: 'invite' }, breakGlass: { id: hub.owner.user.id } });
    expect(settings.callbackUrl).toMatch(/\/auth\/sso\/callback$/);
    expect(settings.providers).toEqual([expect.objectContaining({ id: 'acme', label: 'Acme', confidential: true })]);
    expect(JSON.stringify(settings)).not.toContain(hub.issuer.clientSecret);
    expect((await hub.web.client.call('setup')).sso).toEqual([{ id: 'acme', label: 'Acme' }]);
  });
});
