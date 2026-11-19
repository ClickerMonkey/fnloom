import { verifyJwt } from '@ayepi/auth/server';
import { describe, expect, it } from 'vitest';
import { AccessClaims, ActorId, IdentityProviderConfig, type Tokens } from '@harness/core';
import { ACCESS_TOKEN, HubAuthenticator } from './auth.ts';
import { ScryptHasher } from './hash.ts';
import { testStore } from '../testing.ts';
import { TEST_KEYS } from './testing/rig.ts';

const HOUR = 3_600_000;
const admin = { email: 'Admin@Example.com', name: 'Admin', password: 'correct horse battery', device: 'test' };

async function make(providers: readonly IdentityProviderConfig[] = []) {
  const store = await testStore();
  const clock = { now: 1_800_000_000_000 };
  const auth = new HubAuthenticator({
    store, hasher: new ScryptHasher(10), secret: TEST_KEYS.jwtSecret, accessTtl: 900_000, refreshTtl: 24 * HOUR, providers,
    identity: { identity: () => Promise.resolve({ name: 'Harness', source: 'default' as const, version: '1.2.3' }) }, clock: () => clock.now,
  });
  return { store, clock, auth };
}

/** Bo, made after the admin, with a password of his own (as a hub from before SSO might have). */
async function passwordUser(store: Awaited<ReturnType<typeof testStore>>, role: 'admin' | 'member'): Promise<ActorId> {
  const bo = ActorId.parse('act_bo');
  await store.table('actors').insert({ id: bo, kind: 'user', name: 'Bo', about: '', email: 'bo@example.com', role, createdAt: 1_800_000_000_001, disabled: false });
  await store.table('credentials').insert({ user: bo, kind: 'password', secretHash: await new ScryptHasher(10).hash('bo password!'), createdAt: 1_800_000_000_001 });
  return bo;
}

const claimsOf = (tokens: Tokens): AccessClaims => AccessClaims.parse(verifyJwt(tokens.access, { secret: TEST_KEYS.jwtSecret, ...ACCESS_TOKEN }));

describe('HubAuthenticator', () => {
  it('needs an admin until one is made, then refuses a second', async () => {
    const { auth } = await make();
    await expect(auth.setup()).resolves.toEqual({ needsAdmin: true, name: 'Harness', version: '1.2.3', sso: [] });
    const tokens = await auth.createAdmin(admin);
    expect(tokens?.user).toMatchObject({ email: 'admin@example.com', name: 'Admin', role: 'admin', kind: 'user' });
    expect(tokens?.expiresIn).toBe(900_000);
    await expect(auth.setup()).resolves.toMatchObject({ needsAdmin: false });
    await expect(auth.createAdmin({ ...admin, email: 'other@example.com' })).resolves.toBeUndefined();
  });

  it('issues an access token for the session, that its user resolves to', async () => {
    const { auth } = await make();
    const tokens = await auth.createAdmin(admin);
    if (tokens === undefined) { throw new Error('no tokens'); }
    const claims = claimsOf(tokens);
    expect(claims.actor).toBe(tokens.user.id);
    expect(claims.version).toBe(1);
    await expect(auth.user(claims)).resolves.toEqual(tokens.user);
  });

  it('signs in with the right password (any case of email) and not otherwise', async () => {
    const { auth } = await make();
    await auth.createAdmin(admin);
    await expect(auth.signIn({ email: ' ADMIN@example.com ', password: admin.password, device: 'phone' })).resolves.toMatchObject({ user: { role: 'admin' } });
    await expect(auth.signIn({ email: admin.email, password: 'wrong', device: 'phone' })).resolves.toBeUndefined();
    await expect(auth.signIn({ email: 'nobody@example.com', password: admin.password, device: 'phone' })).resolves.toBeUndefined();
  });

  it('refuses a disabled user', async () => {
    const { auth, store } = await make();
    const tokens = await auth.createAdmin(admin);
    if (tokens === undefined) { throw new Error('no tokens'); }
    await store.table('actors').update(tokens.user.id, { disabled: true });
    await expect(auth.signIn(admin)).resolves.toBeUndefined();
    await expect(auth.user(claimsOf(tokens))).resolves.toBeUndefined();
    await expect(auth.refresh(tokens.refresh)).resolves.toBeUndefined();
  });

  it('rotates the refresh token, and a reused one ends the session', async () => {
    const { auth } = await make();
    const first = await auth.createAdmin(admin);
    if (first === undefined) { throw new Error('no tokens'); }
    const second = await auth.refresh(first.refresh);
    expect(second?.refresh).toBeDefined();
    expect(second?.refresh).not.toBe(first.refresh);
    await expect(auth.refresh(first.refresh)).resolves.toBeUndefined();
    if (second === undefined) { throw new Error('no tokens'); }
    await expect(auth.refresh(second.refresh)).resolves.toBeUndefined();
    await expect(auth.user(claimsOf(second))).resolves.toBeUndefined();
  });

  it('ends a session not refreshed within the refresh lifetime', async () => {
    const { auth, clock } = await make();
    const tokens = await auth.createAdmin(admin);
    if (tokens === undefined) { throw new Error('no tokens'); }
    clock.now += 25 * HOUR;
    await expect(auth.refresh(tokens.refresh)).resolves.toBeUndefined();
  });

  it.each(['', 'nodot', '.secret', 'session.', 'aus_missing.secret'])('refuses a malformed or unknown refresh token %j', async (refresh) => {
    const { auth } = await make();
    await auth.createAdmin(admin);
    await expect(auth.refresh(refresh)).resolves.toBeUndefined();
  });

  it('signing out and revoking access end the tokens at once', async () => {
    const { auth } = await make();
    const tokens = await auth.createAdmin(admin);
    if (tokens === undefined) { throw new Error('no tokens'); }
    const other = await auth.signIn(admin);
    if (other === undefined) { throw new Error('no tokens'); }
    await auth.signOut(claimsOf(tokens));
    await expect(auth.user(claimsOf(tokens))).resolves.toBeUndefined();
    await expect(auth.user(claimsOf(other))).resolves.toBeDefined();
    await auth.revokeAccess(claimsOf(other).session);
    await expect(auth.user(claimsOf(other))).resolves.toBeUndefined();
    const renewed = await auth.refresh(other.refresh);
    expect(renewed === undefined ? undefined : claimsOf(renewed).version).toBe(2);
  });

  it('makes the admin from the environment only once', async () => {
    const { auth } = await make();
    await expect(auth.bootstrap({ email: 'boot@example.com', password: 'a long password' })).resolves.toBe(true);
    await expect(auth.bootstrap({ email: 'boot@example.com', password: 'a long password' })).resolves.toBe(false);
    await expect(auth.signIn({ email: 'boot@example.com', password: 'a long password', device: 'x' })).resolves.toMatchObject({ user: { name: 'boot' } });
  });

  it('rotates once when two refreshes race with the same token', async () => {
    const { auth } = await make();
    const tokens = await auth.createAdmin(admin);
    if (tokens === undefined) { throw new Error('no tokens'); }
    const results = await Promise.all([auth.refresh(tokens.refresh), auth.refresh(tokens.refresh)]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('keeps passwords for the break-glass admin only once SSO is configured', async () => {
    const acme = IdentityProviderConfig.parse({ id: 'acme', label: 'Acme', issuer: 'https://id.example.test', clientId: 'c' });
    const { auth, store } = await make([acme]);
    await expect(auth.setup()).resolves.toMatchObject({ sso: [{ id: 'acme', label: 'Acme' }] });
    const tokens = await auth.createAdmin(admin);
    if (tokens === undefined) { throw new Error('no tokens'); }
    // the bootstrap admin keeps a password, as a break-glass sign-in
    await expect(auth.signIn(admin)).resolves.toMatchObject({ user: { id: tokens.user.id } });
    await expect(auth.passwordAllowed(tokens.user)).resolves.toBe(true);
    // anyone else holding a password (made before SSO was on) can no longer use it
    const bo = await passwordUser(store, 'admin');
    await expect(auth.passwordAllowed({ id: bo })).resolves.toBe(false);
    await expect(auth.signIn({ email: 'bo@example.com', password: 'bo password!', device: 'x' })).resolves.toBeUndefined();
  });

  it('lets everyone with a password sign in with it while no SSO provider is configured', async () => {
    const { auth, store } = await make();
    await auth.createAdmin(admin);
    const bo = await passwordUser(store, 'member');
    await expect(auth.signIn({ email: 'bo@example.com', password: 'bo password!', device: 'x' })).resolves.toMatchObject({ user: { id: bo } });
  });

  it('refuses a refresh token that is malformed or names no session', async () => {
    const { auth } = await make();
    await expect(auth.refresh('no-dot')).resolves.toBeUndefined();
    await expect(auth.refresh('aus_missing.secret')).resolves.toBeUndefined();
    await expect(auth.refresh('.secret')).resolves.toBeUndefined();
  });
});
