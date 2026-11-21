/**
 * Sign-in: a password, or an SSO provider (OpenID Connect, `api/sso.ts`). The first start makes one admin account
 * (from the setup page, or from `HARNESS_ADMIN_EMAIL` / `HARNESS_ADMIN_PASSWORD`). The setup page needs the one-time
 * setup code the hub makes when it starts with no one in it (`announceSetup`: printed to its log as a link and
 * written to the data folder), so nobody else who can reach the hub's port can make themselves its admin first. Once
 * SSO providers are configured, that bootstrap admin is the only one who signs in with a password (break-glass);
 * everyone else signs in through a provider, linked and synced by `IdentityLinker`. Every browser that signs in, either way, gets an `AuthSession`: a
 * short access token (an HS256 JWT from `@ayepi/auth`) carrying the session and its version, and a refresh token stored
 * only as a hash. Revoking bumps or removes the session, so every request (`user`) sees it at once.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type { Logger } from '@ayepi/log';
import { signJwt } from '@ayepi/auth/server';
import {
  AccessClaims, mintId, ROTATED_KEPT, UserView, type AuthSession, type AuthSessionId, type IdentityProviderConfig, type IdRandom, type SetupState, type SsoOutcome, type Tokens, type UserActor,
} from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { Authenticator, ExternalSignIn, PasswordHasher } from './index.ts';
import { sha256Hex } from '../link/keys.ts';
import type { HubIdentityService } from '../boot/identity.ts';
import type { EventBus } from '../bus.ts';
import { breakGlassAdmin, findUserByEmail, IdentityLinker, normalEmail, outcomeOf, type ExternalClaims } from './identities.ts';

/** Who access tokens come from and are for; the bearer middleware checks both. */
export const ACCESS_TOKEN = { issuer: 'harness-hub', audience: 'web' } as const;

/** What the authenticator needs. */
export interface AuthOptions {
  readonly store: HubStore;
  readonly hasher: PasswordHasher;
  readonly secret: string;
  /** Access token lifetime. */
  readonly accessTtl: number;
  /** A session not refreshed for this long ends. */
  readonly refreshTtl: number;
  /** The hub's display name and version, for the sign-in and setup page. */
  readonly identity: Pick<HubIdentityService, 'identity'>;
  readonly clock: () => number;
  readonly random?: IdRandom;
  /** The SSO providers (`HARNESS_SSO_PROVIDERS`); with any, only the break-glass admin signs in with a password. */
  readonly providers?: readonly IdentityProviderConfig[];
  /** Told when a sign-in ends (`access.ended`: signed out, revoked, or its refresh token stolen), so its live events stop. */
  readonly bus?: Pick<EventBus, 'publish'>;
}

const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The hub's authenticator: break-glass password and SSO, both ending in a sign-in session. */
export class HubAuthenticator implements Authenticator {
  readonly #o: AuthOptions;
  readonly #linker: IdentityLinker;
  /** A hash to check against when the email is unknown, so both answers take as long. */
  #decoy: Promise<string> | undefined;
  /** The current setup code's hash; undefined while there is none (before `openSetup`, or once the admin is made). */
  #setupHash: string | undefined;

  constructor(options: AuthOptions) {
    this.#o = options;
    this.#linker = new IdentityLinker(options.clock, options.random);
  }

  /** Whether any SSO provider is configured (then only the break-glass admin keeps a password). */
  get sso(): boolean {
    return (this.#o.providers?.length ?? 0) > 0;
  }

  async setup(): Promise<SetupState> {
    const { name, version } = await this.#o.identity.identity();
    const sso = (this.#o.providers ?? []).map(({ id, label }) => ({ id, label }));
    return { needsAdmin: !(await this.#hasUsers()), name, version, sso };
  }

  async openSetup(): Promise<string | undefined> {
    if (await this.#hasUsers()) {
      this.#setupHash = undefined;
      return undefined;
    }
    const code = randomBytes(SETUP_CODE_BYTES).toString('hex');
    this.#setupHash = sha256Hex(code);
    return code;
  }

  setupMatches(code: string): boolean {
    return this.#setupHash !== undefined && sameHash(sha256Hex(code.trim()), this.#setupHash);
  }

  async createAdmin(input: { email: string; name: string; password: string; setup: string; device: string }): Promise<Tokens | undefined> {
    if (!this.setupMatches(input.setup)) { return undefined; }
    const tokens = await this.#makeAdmin(input);
    if (tokens !== undefined) { this.#setupHash = undefined; }
    return tokens;
  }

  /** Make the admin account unless someone is there already. */
  async #makeAdmin(input: { email: string; name: string; password: string; device: string }): Promise<Tokens | undefined> {
    const secretHash = await this.#o.hasher.hash(input.password);
    return this.#o.store.tx(async (store) => {
      if (await this.#hasUsers(store)) { return undefined; }
      const now = this.#o.clock();
      const user: UserActor = {
        id: mintId('actor', this.#o.random), kind: 'user', name: input.name, about: '', email: normalEmail(input.email), role: 'admin',
        createdAt: now, disabled: false,
      };
      await store.table('actors').insert(user);
      await store.table('credentials').insert({ user: user.id, kind: 'password', secretHash, createdAt: now });
      return this.#openSession(store, user, input.device);
    });
  }

  /** Make the admin from the environment on first start; does nothing once a user exists. */
  async bootstrap(input: { email: string; password: string }): Promise<boolean> {
    const name = input.email.split('@')[0] ?? input.email;
    return (await this.#makeAdmin({ ...input, name, device: 'bootstrap' })) !== undefined;
  }

  async signIn(input: { email: string; password: string; device: string }): Promise<Tokens | undefined> {
    const user = await findUserByEmail(this.#o.store, input.email);
    const credential = user === undefined ? undefined : await this.#o.store.table('credentials').get({ user: user.id, kind: 'password' });
    if (user === undefined || credential === undefined || user.disabled || !(await this.passwordAllowed(user))) {
      await this.#o.hasher.verify(input.password, await this.#decoyHash());
      return undefined;
    }
    if (!(await this.#o.hasher.verify(input.password, credential.secretHash))) { return undefined; }
    return this.#openSession(this.#o.store, user, input.device);
  }

  /** Whether this person may sign in with a password: anyone with one until SSO is configured, then the break-glass admin only. */
  async passwordAllowed(user: Pick<UserActor, 'id'>, store: HubStore = this.#o.store): Promise<boolean> {
    return !this.sso || (await breakGlassAdmin(store))?.id === user.id;
  }

  /**
   * A sign-in through an SSO provider whose ID token is verified: linked, made and synced as `IdentityLinker` says,
   * in one transaction, then a session like a password sign-in's. Refused with the reason in words.
   */
  async signInExternal(claims: ExternalClaims, device: string): Promise<ExternalSignIn> {
    return this.#o.store.tx(async (store) => {
      const plan = await this.#linker.plan(store, claims);
      if (!plan.allowed) return { refused: plan.reason };
      const user = await this.#linker.apply(store, plan);
      return { tokens: await this.#openSession(store, user, device), outcome: outcomeOf(plan) };
    });
  }

  /** What a sign-in with these claims would do, changing nothing (a test sign-in). */
  async preview(claims: ExternalClaims): Promise<SsoOutcome> {
    return outcomeOf(await this.#linker.plan(this.#o.store, claims));
  }

  async refresh(refresh: string): Promise<Tokens | undefined> {
    const parsed = parseRefresh(refresh);
    if (parsed === undefined) { return undefined; }
    // One transaction, so two refreshes racing with the same token can't both rotate it.
    const ended: AuthSession[] = [];
    const tokens = await this.#o.store.tx((store) => this.#rotate(store, parsed, (session) => { ended.push(session); }));
    for (const session of ended) { this.#ended(session.user, session.id); }
    return tokens;
  }

  async #rotate(store: HubStore, parsed: RefreshParts, end: (session: AuthSession) => void): Promise<Tokens | undefined> {
    const sessions = store.table('authSessions');
    const session = await sessions.get(parsed.session);
    if (session === undefined) { return undefined; }
    const now = this.#o.clock();
    const hash = sha256Hex(parsed.secret);
    if (!sameHash(hash, session.refreshHash)) {
      // A refresh token this session rotated away from was used: someone else has had it. End the session. Any other
      // secret is only refused, so knowing a session's id isn't enough to sign it out.
      if ((session.rotatedHashes ?? []).some((old) => sameHash(hash, old))) {
        await sessions.remove(session.id);
        end(session);
      }
      return undefined;
    }
    if (now - session.lastSeenAt > this.#o.refreshTtl) {
      await sessions.remove(session.id);
      end(session);
      return undefined;
    }
    const user = await this.#activeUser(session.user, store);
    if (user === undefined) { return undefined; }
    const secret = this.#secret();
    const rotatedHashes = [session.refreshHash, ...(session.rotatedHashes ?? [])].slice(0, ROTATED_KEPT);
    const updated = await sessions.update(session.id, { refreshHash: sha256Hex(secret), rotatedHashes, lastSeenAt: now });
    return this.#tokens(updated, user, secret);
  }

  async signOut(claims: AccessClaims): Promise<void> {
    await this.#o.store.table('authSessions').remove(claims.session);
    this.#ended(claims.actor, claims.session);
  }

  async user(claims: AccessClaims): Promise<UserView | undefined> {
    const session = await this.#o.store.table('authSessions').get(claims.session);
    if (session?.version !== claims.version || session.user !== claims.actor) { return undefined; }
    const user = await this.#activeUser(session.user);
    return user === undefined ? undefined : UserView.parse(user);
  }

  /** Revoke every token of a session that is still signed in (its refresh token keeps working). */
  async revokeAccess(session: AuthSessionId): Promise<void> {
    const sessions = this.#o.store.table('authSessions');
    const current = await sessions.get(session);
    if (current !== undefined) {
      await sessions.update(session, { version: current.version + 1 });
      this.#ended(current.user, session);
    }
  }

  /** Tell the hub a sign-in ended (after the change is stored, so a check that reads it next sees it gone). */
  #ended(user: AuthSession['user'], session: AuthSessionId): void {
    this.#o.bus?.publish('access.ended', { user, session });
  }

  async #openSession(store: HubStore, user: UserActor, device: string): Promise<Tokens> {
    const now = this.#o.clock();
    const secret = this.#secret();
    const session = await store.table('authSessions').insert({
      id: mintId('authSession', this.#o.random), user: user.id, version: 1, refreshHash: sha256Hex(secret), device, createdAt: now, lastSeenAt: now,
    });
    return this.#tokens(session, user, secret);
  }

  #tokens(session: AuthSession, user: UserActor, secret: string): Tokens {
    const claims = AccessClaims.parse({ actor: user.id, session: session.id, version: session.version });
    const { token } = signJwt(claims, { secret: this.#o.secret, expiresIn: Math.floor(this.#o.accessTtl / 1000), ...ACCESS_TOKEN });
    return { access: token, refresh: `${session.id}.${secret}`, expiresIn: this.#o.accessTtl, user: UserView.parse(user) };
  }

  #secret(): string {
    return randomBytes(32).toString('base64url');
  }

  #decoyHash(): Promise<string> {
    this.#decoy ??= this.#o.hasher.hash(randomBytes(16).toString('hex'));
    return this.#decoy;
  }

  async #hasUsers(store: HubStore = this.#o.store): Promise<boolean> {
    return (await store.table('actors').count({ kind: 'user' })) > 0;
  }

  async #activeUser(id: string, store: HubStore = this.#o.store): Promise<UserActor | undefined> {
    const actor = await store.table('actors').get(id);
    return actor?.kind === 'user' && !actor.disabled ? actor : undefined;
  }
}

/** How many random bytes a setup code has (written as hex, twice as many characters). */
const SETUP_CODE_BYTES = 10;

/** The file in the data folder the setup code is written to while the hub has no one. */
export const SETUP_FILE = 'setup-code.txt';

/** The page a setup link opens, with the code filled in. */
export function setupLink(hubUrl: string, code: string): string {
  const url = new URL('/sign-in', hubUrl);
  url.searchParams.set('setup', code);
  return url.toString();
}

/**
 * At start: while the hub has no one, make a setup code, write it to `file` (only this account can read it) and print
 * the setup link to the log, so whoever runs the hub can make the admin. Once someone is there, remove the file.
 */
export async function announceSetup(auth: Pick<Authenticator, 'openSetup'>, options: { readonly file: string; readonly hubUrl: string; readonly log: Logger }): Promise<void> {
  const code = await auth.openSetup();
  // removed first either way: a mode only applies to a file being made
  await rm(options.file, { force: true });
  if (code === undefined) { return; }
  await writeFile(options.file, `${code}\n`, { mode: 0o600 });
  options.log.warn('auth.setup.waiting', { link: setupLink(options.hubUrl, code), file: options.file, note: 'Open the link to make the admin account. The code works once.' });
}

/** A refresh token is `<session id>.<secret>`. */
interface RefreshParts {
  readonly session: string;
  readonly secret: string;
}

function parseRefresh(refresh: string): RefreshParts | undefined {
  const dot = refresh.lastIndexOf('.');
  if (dot <= 0 || dot === refresh.length - 1) { return undefined; }
  return { session: refresh.slice(0, dot), secret: refresh.slice(dot + 1) };
}
