/**
 * Sign-in in single admin mode. The first start makes one admin account (from the setup page, or from
 * `HARNESS_ADMIN_EMAIL` / `HARNESS_ADMIN_PASSWORD`). Every browser that signs in gets an `AuthSession`: a short access
 * token (an HS256 JWT from `@ayepi/auth`) carrying the session and its version, and a refresh token stored only as a
 * hash. Revoking bumps or removes the session, so every request (`user`) sees it at once.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { signJwt } from '@ayepi/auth/server';
import {
  AccessClaims, mintId, UserView, type AuthSession, type AuthSessionId, type IdRandom, type SetupState, type Tokens, type UserActor,
} from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { Authenticator, PasswordHasher } from './index.ts';
import { firstRow } from '../store/rows.ts';
import { sha256Hex } from '../link/keys.ts';
import type { HubIdentityService } from '../boot/identity.ts';

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
}

const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** An email as the hub keeps and compares it: trimmed, lower case. */
export const normalEmail = (email: string): string => email.trim().toLowerCase();

/** The user with this email (in any case), or undefined. */
export function findUserByEmail(store: HubStore, email: string): Promise<UserActor | undefined> {
  const wanted = normalEmail(email);
  return firstRow(
    store.table('actors'), { where: { kind: 'user' } },
    (actor): actor is UserActor => actor.kind === 'user' && normalEmail(actor.email) === wanted,
  );
}

/** The single-admin authenticator. */
export class AdminAuthenticator implements Authenticator {
  readonly #o: AuthOptions;
  /** A hash to check against when the email is unknown, so both answers take as long. */
  #decoy: Promise<string> | undefined;

  constructor(options: AuthOptions) {
    this.#o = options;
  }

  async setup(): Promise<SetupState> {
    const { name, version } = await this.#o.identity.identity();
    return { needsAdmin: !(await this.#hasUsers()), name, version };
  }

  async createAdmin(input: { email: string; name: string; password: string; device: string }): Promise<Tokens | undefined> {
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
    return (await this.createAdmin({ ...input, name, device: 'bootstrap' })) !== undefined;
  }

  async signIn(input: { email: string; password: string; device: string }): Promise<Tokens | undefined> {
    const user = await findUserByEmail(this.#o.store, input.email);
    const credential = user === undefined ? undefined : await this.#o.store.table('credentials').get({ user: user.id, kind: 'password' });
    if (user === undefined || credential === undefined || user.disabled) {
      await this.#o.hasher.verify(input.password, await this.#decoyHash());
      return undefined;
    }
    if (!(await this.#o.hasher.verify(input.password, credential.secretHash))) { return undefined; }
    return this.#openSession(this.#o.store, user, input.device);
  }

  async refresh(refresh: string): Promise<Tokens | undefined> {
    const parsed = parseRefresh(refresh);
    if (parsed === undefined) { return undefined; }
    // One transaction, so two refreshes racing with the same token can't both rotate it.
    return this.#o.store.tx((store) => this.#rotate(store, parsed));
  }

  async #rotate(store: HubStore, parsed: RefreshParts): Promise<Tokens | undefined> {
    const sessions = store.table('authSessions');
    const session = await sessions.get(parsed.session);
    if (session === undefined) { return undefined; }
    const now = this.#o.clock();
    if (!sameHash(sha256Hex(parsed.secret), session.refreshHash)) {
      // A refresh token that is no longer current was used: someone else has had it. End the session.
      await sessions.remove(session.id);
      return undefined;
    }
    if (now - session.lastSeenAt > this.#o.refreshTtl) {
      await sessions.remove(session.id);
      return undefined;
    }
    const user = await this.#activeUser(session.user, store);
    if (user === undefined) { return undefined; }
    const secret = this.#secret();
    const updated = await sessions.update(session.id, { refreshHash: sha256Hex(secret), lastSeenAt: now });
    return this.#tokens(updated, user, secret);
  }

  async signOut(claims: AccessClaims): Promise<void> {
    await this.#o.store.table('authSessions').remove(claims.session);
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
    if (current !== undefined) { await sessions.update(session, { version: current.version + 1 }); }
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
