/**
 * SSO sign-in through OpenID Connect providers (`HARNESS_SSO_PROVIDERS`), with `@ayepi/auth/oauth`'s `OidcClient`
 * doing all of OpenID Connect: discovery, PKCE, `state` and `nonce`, the code exchange, ID token verification on the
 * provider's key set, and userinfo. The hub keeps nothing between the start and the callback: what finishing needs
 * (the `state`, `nonce` and PKCE verifier, where to go after) is a signed, expiring payload (`SignedPayloads`, the
 * same helper as the connections' `state`) in an httpOnly cookie on the callback path, so the sign-in finishes only in
 * the browser that started it, and the verifier never travels through the provider.
 *
 * A finished sign-in goes to `HubAuthenticator.signInExternal` (linking, the first-sign-in policy, roles and groups),
 * and the callback hands the sign-in page the session's refresh token in the URL fragment, which never reaches a
 * server; the page swaps it at once (refresh tokens rotate on use). A test sign-in (an admin's, from the People page)
 * signs nobody in: it keeps what the provider sent and what a real sign-in would do, for that admin to read.
 */
import { JwksCache, OAuthError, OidcClient } from '@ayepi/auth/oauth';
import {
  ActorId, Json, SSO_CALLBACK_PATH, SSO_HANDOFF_KEY, SSO_TEST_PAGE, SsoProviderId, UserView,
  type IdentityProviderConfig, type SignInSettings, type SsoCheck, type SsoCheckStep, type SsoTestResult,
} from '@harness/core';
import { z } from 'zod';
import type { Logger } from '@ayepi/log';
import type { HubStore } from '../store/index.ts';
import type { Authenticator } from './index.ts';
import { breakGlassAdmin, signInPolicy, type ExternalClaims } from './identities.ts';
import { randomSecret, SignedPayloads } from './signed.ts';

/** The cookie that carries a sign-in in flight from its start to the callback. */
export const SSO_COOKIE = 'harness_sso';

/** How long a test sign-in's result is kept for its admin. */
const TEST_KEPT = 15 * 60_000;

/** A sign-in in flight, as its cookie carries it. */
const Pending = z.object({
  /** The provider. */
  p: SsoProviderId,
  /** The OIDC `state`, `nonce`, PKCE verifier and redirect URI (`OidcPending`). */
  s: z.string(), n: z.string(), v: z.string(), r: z.string(),
  /** Where to go after (a path in the app). */
  x: z.string().optional(),
  /** A test sign-in: its id and the admin who ran it. */
  t: z.string().optional(), a: ActorId.optional(),
});

/** The cookie a start sets: httpOnly, on the callback path, for the sign-in window. */
export interface SsoCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  /** Seconds. */
  readonly maxAge: number;
  readonly secure: boolean;
}

/** A started sign-in: the provider's URL and the cookie that binds it to this browser. */
export interface SsoStart {
  readonly url: string;
  readonly cookie: SsoCookie;
}

/** Where the callback sends the browser, and the cookie to clear. */
export interface SsoCallbackAnswer {
  readonly location: string;
  readonly clear: string;
}

/** SSO sign-in: start, callback, provider checks and test sign-ins. */
export interface SsoService {
  /** The configured providers. */
  readonly providers: readonly IdentityProviderConfig[];
  /** Begin a sign-in (or a test sign-in, for `test.admin`). Refused for an unknown provider; throws when it can't be reached. */
  start(provider: string, options: { readonly next?: string | undefined; readonly test?: { readonly id: string; readonly admin: ActorId } | undefined }): Promise<SsoStart>;
  /** The provider sent the browser back with these query params and these cookies. Never throws: problems go in the location. */
  callback(params: URLSearchParams, cookies: Readonly<Record<string, string>>, device: string): Promise<SsoCallbackAnswer>;
  /** Fetch a provider's discovery document and key set now. */
  check(provider: string): Promise<SsoCheck>;
  /** A test sign-in's result, for the admin who ran it; undefined while it hasn't come back (or for anyone else). */
  testResult(test: string, admin: ActorId): SsoTestResult | undefined;
  /** The Sign-in tab: providers (no secrets), the policy, the break-glass admin, the redirect URI. */
  settings(): Promise<SignInSettings>;
}

/** What the SSO service uses. */
export interface SsoDeps {
  readonly providers: readonly IdentityProviderConfig[];
  readonly auth: Pick<Authenticator, 'signInExternal' | 'preview'>;
  readonly store: HubStore;
  readonly log: Logger;
  readonly clock: () => number;
  /** The hub's public URL (`HARNESS_URL`): the redirect URI is under it. */
  readonly hubUrl: string;
  /** How long a person has to come back from the provider (`HARNESS_SSO_WINDOW`). */
  readonly window: number;
  /** Signs the cookie; a new key each start. */
  readonly key?: Buffer;
  /** How providers are reached (tests give a fake issuer). */
  readonly fetch?: typeof fetch;
}

/** The SSO service over `OidcClient`s, one per provider, made when first used and kept (with their discovery and keys). */
export class OidcSignIns implements SsoService {
  readonly providers: readonly IdentityProviderConfig[];
  readonly #deps: SsoDeps;
  readonly #signed: SignedPayloads;
  readonly #clients = new Map<string, OidcClient>();
  readonly #tests = new Map<string, { readonly admin: ActorId; readonly result: SsoTestResult }>();

  constructor(deps: SsoDeps) {
    this.#deps = deps;
    this.providers = deps.providers;
    this.#signed = new SignedPayloads(deps.clock, deps.key);
  }

  get #redirect(): string {
    return new URL(SSO_CALLBACK_PATH, this.#deps.hubUrl).toString();
  }

  async start(provider: string, options: { readonly next?: string | undefined; readonly test?: { readonly id: string; readonly admin: ActorId } | undefined }): Promise<SsoStart> {
    const config = this.#provider(provider);
    const { url, pending } = await this.#client(config).begin({ redirectUri: this.#redirect, scope: config.scope }).catch((error: unknown) => {
      this.#deps.log.warn('sso.start.failed', { provider: config.id }, error);
      throw error;
    });
    const next = safePath(options.next);
    const value = this.#signed.sign({
      p: config.id, s: pending.state, n: pending.nonce, v: pending.verifier, r: pending.redirectUri,
      ...(next === undefined ? {} : { x: next }), ...(options.test === undefined ? {} : { t: options.test.id, a: options.test.admin }),
    }, this.#deps.clock() + this.#deps.window);
    return { url, cookie: { name: SSO_COOKIE, value, path: SSO_CALLBACK_PATH, maxAge: Math.ceil(this.#deps.window / 1000), secure: this.#redirect.startsWith('https:') } };
  }

  async callback(params: URLSearchParams, cookies: Readonly<Record<string, string>>, device: string): Promise<SsoCallbackAnswer> {
    const pending = this.#signed.read(Pending, cookies[SSO_COOKIE]);
    const config = pending === undefined ? undefined : this.providers.find((p) => p.id === pending.p);
    if (pending === undefined || config === undefined) {
      return { location: signInPage({ problem: 'This sign-in has expired or was started in another browser. Sign in again.' }), clear: SSO_COOKIE };
    }
    const test = pending.t !== undefined && pending.a !== undefined ? { id: pending.t, admin: pending.a } : undefined;
    let claims: ExternalClaims;
    try {
      claims = await this.#finish(config, params, { state: pending.s, nonce: pending.n, verifier: pending.v, redirectUri: pending.r });
    } catch (error) {
      const problem = problemOf(config, error);
      this.#deps.log.warn('sso.refused', { provider: config.id, test: test !== undefined, code: error instanceof OAuthError ? error.code : 'error' });
      if (test !== undefined) {
        this.#keep(test, { id: test.id, provider: config.id, at: this.#deps.clock(), problem, emailVerified: false, claims: {} });
        return { location: testPage(test.id), clear: SSO_COOKIE };
      }
      return { location: signInPage({ problem, next: pending.x }), clear: SSO_COOKIE };
    }
    if (test !== undefined) {
      const outcome = await this.#deps.auth.preview(claims);
      this.#keep(test, { ...claimFacts(claims), id: test.id, provider: config.id, at: this.#deps.clock(), outcome });
      return { location: testPage(test.id), clear: SSO_COOKIE };
    }
    const signedIn = await this.#deps.auth.signInExternal(claims, device);
    if ('refused' in signedIn) {
      this.#deps.log.warn('sso.sign-in.refused', { provider: config.id, reason: signedIn.refused });
      return { location: signInPage({ problem: signedIn.refused, next: pending.x }), clear: SSO_COOKIE };
    }
    this.#deps.log.info('sso.signed-in', { provider: config.id, user: signedIn.tokens.user.id, link: signedIn.outcome.link });
    return { location: `${signInPage({ next: pending.x })}#${new URLSearchParams({ [SSO_HANDOFF_KEY]: signedIn.tokens.refresh }).toString()}`, clear: SSO_COOKIE };
  }

  async check(provider: string): Promise<SsoCheck> {
    const config = this.#provider(provider);
    const at = this.#deps.clock();
    let discovery: SsoCheckStep;
    let keys: SsoCheckStep = { ok: false, detail: 'Not checked: discovery failed.' };
    try {
      // a fresh client, so the check reaches the provider now and doesn't reuse what a sign-in kept
      const metadata = await this.#newClient(config).metadata();
      discovery = { ok: true, detail: `Found ${metadata.issuer}: signs in at ${metadata.authorization_endpoint}.` };
      try {
        const set = await new JwksCache(metadata.jwks_uri, this.#fetchOptions()).refresh();
        const count = set.keys.length;
        keys = count === 0 ? { ok: false, detail: `${metadata.jwks_uri} has no keys.` } : { ok: true, detail: `${count} signing ${count === 1 ? 'key' : 'keys'} at ${metadata.jwks_uri}.` };
      } catch (error) {
        keys = { ok: false, detail: messageOf(error) };
      }
    } catch (error) {
      discovery = { ok: false, detail: messageOf(error) };
    }
    return { provider: config.id, ok: discovery.ok && keys.ok, discovery, keys, checkedAt: at };
  }

  testResult(test: string, admin: ActorId): SsoTestResult | undefined {
    this.#prune();
    const kept = this.#tests.get(test);
    return kept?.admin === admin ? kept.result : undefined;
  }

  async settings(): Promise<SignInSettings> {
    const [policy, breakGlass] = await Promise.all([signInPolicy(this.#deps.store), breakGlassAdmin(this.#deps.store)]);
    return {
      providers: this.providers.map(({ clientSecret, ...config }) => ({ ...config, confidential: clientSecret !== undefined })),
      policy, ...(breakGlass === undefined ? {} : { breakGlass: UserView.parse(breakGlass) }), callbackUrl: this.#redirect,
    };
  }

  /** Finish the code flow and gather the claims: the verified ID token's, with userinfo's where it adds any. */
  async #finish(config: IdentityProviderConfig, params: URLSearchParams, pending: { state: string; nonce: string; verifier: string; redirectUri: string }): Promise<ExternalClaims> {
    const client = this.#client(config);
    const { tokens, claims } = await client.finish(params, pending);
    const metadata = await client.metadata();
    const info = config.userinfo && metadata.userinfo_endpoint !== undefined ? await client.userinfo(tokens.access_token, claims.sub) : {};
    return { provider: config, issuer: claims.iss, sub: claims.sub, claims: jsonClaims({ ...info, ...claims }) };
  }

  #keep(test: { readonly id: string; readonly admin: ActorId }, result: SsoTestResult): void {
    this.#prune();
    this.#tests.set(test.id, { admin: test.admin, result });
  }

  /** Drop test results older than they are kept. */
  #prune(): void {
    const now = this.#deps.clock();
    for (const [id, kept] of this.#tests) { if (now - kept.result.at > TEST_KEPT) this.#tests.delete(id); }
  }

  #provider(id: string): IdentityProviderConfig {
    const config = this.providers.find((p) => p.id === id);
    if (config === undefined) throw new UnknownProvider(id);
    return config;
  }

  #client(config: IdentityProviderConfig): OidcClient {
    let client = this.#clients.get(config.id);
    if (client === undefined) {
      client = this.#newClient(config);
      this.#clients.set(config.id, client);
    }
    return client;
  }

  #newClient(config: IdentityProviderConfig): OidcClient {
    return new OidcClient({
      issuer: config.issuer, clientId: config.clientId, ...(config.clientSecret === undefined ? {} : { clientSecret: config.clientSecret }),
      ...this.#fetchOptions(),
    });
  }

  #fetchOptions(): { fetch?: typeof fetch; now: () => number } {
    return { now: this.#deps.clock, ...(this.#deps.fetch === undefined ? {} : { fetch: this.#deps.fetch }) };
  }
}

/** A provider id no provider has. */
export class UnknownProvider extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`no sign-in provider "${provider}"`);
    this.provider = provider;
    this.name = 'UnknownProvider';
  }
}

/** A new test sign-in's id. */
export function newTestId(): string {
  return randomSecret(16);
}

/** The sign-in page, with a problem to show and where to go after. */
function signInPage(query: { readonly problem?: string | undefined; readonly next?: string | undefined }): string {
  const params = new URLSearchParams();
  if (query.next !== undefined) params.set('next', query.next);
  if (query.problem !== undefined) params.set('problem', query.problem);
  const written = params.toString();
  return written === '' ? '/sign-in' : `/sign-in?${written}`;
}

/** The People page's Sign-in tab, showing a test sign-in's result. */
function testPage(test: string): string {
  return `${SSO_TEST_PAGE}?${new URLSearchParams({ test }).toString()}`;
}

/** A path in this app, never another site. */
function safePath(next: string | undefined): string | undefined {
  return next !== undefined && /^\/(?![/\\])/.test(next) ? next : undefined;
}

/** Claims as JSON (values JSON can't hold are left out). */
function jsonClaims(claims: Readonly<Record<string, unknown>>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(claims)) {
    const read = Json.safeParse(value);
    if (read.success) out[key] = read.data;
  }
  return out;
}

/** The facts a test result shows about who the provider said it is. */
function claimFacts(claims: ExternalClaims): Pick<SsoTestResult, 'subject' | 'email' | 'emailVerified' | 'claims'> {
  const email = claims.claims['email'];
  const verified = claims.claims['email_verified'];
  return { subject: claims.sub, ...(typeof email === 'string' ? { email } : {}), emailVerified: verified === true || verified === 'true', claims: { ...claims.claims } };
}

/** A failed provider sign-in in words for the person. */
function problemOf(config: IdentityProviderConfig, error: unknown): string {
  if (error instanceof OAuthError) {
    if (error.code === 'access_denied') return `${config.label} sign-in was cancelled.`;
    if (error.code === 'state_mismatch') return 'This sign-in link doesn\'t match the one started here. Sign in again.';
    return `${config.label} sign-in failed: ${error.message}`;
  }
  return `${config.label} couldn't be reached. Try again in a moment.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
