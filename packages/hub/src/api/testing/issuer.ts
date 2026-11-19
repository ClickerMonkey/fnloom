/**
 * A fake OpenID provider for SSO tests, answering through a `fetch` (no network): discovery, a key set, the token
 * endpoint (checking the PKCE verifier, the client and the redirect) and userinfo. `authorize` plays the person
 * signing in at the provider: it reads the authorization URL the hub made and returns the callback query the provider
 * would redirect back with. ID tokens are real RS256 JWTs signed with a key made here, so the hub's verification
 * (`@ayepi/auth/oauth`) runs for real.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/** What the fake provider says about the person who signs in. */
export interface FakeAccount {
  readonly sub: string;
  /** Claims put in the ID token (email, email_verified, name, groups, …). */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Claims only userinfo answers with. */
  readonly userinfo?: Readonly<Record<string, unknown>>;
}

/** What a test can change about the provider. */
export interface FakeIssuerOptions {
  readonly issuer?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly now: () => number;
}

interface Granted {
  readonly account: FakeAccount;
  readonly nonce: string;
  readonly challenge: string;
  readonly redirect: string;
  readonly clientId: string;
}

/** A fake provider. */
export class FakeIssuer {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Requests it answered, by path. */
  readonly seen: string[] = [];
  /** Turn discovery off (the provider is down). */
  down = false;
  /** Sign ID tokens for another audience (a token meant for another client). */
  audience: string | undefined;
  readonly #now: () => number;
  readonly #key: KeyObject;
  readonly #jwk: Readonly<Record<string, unknown>>;
  readonly #codes = new Map<string, Granted>();
  readonly #access = new Map<string, FakeAccount>();
  #counter = 0;

  constructor(options: FakeIssuerOptions) {
    this.issuer = options.issuer ?? 'https://id.example.test';
    this.clientId = options.clientId ?? 'harness-client';
    this.clientSecret = options.clientSecret ?? 'harness-secret';
    this.#now = options.now;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#key = privateKey;
    this.#jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  }

  /** The provider's `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.seen.push(url.pathname);
    if (url.origin !== new URL(this.issuer).origin) return new Response('not found', { status: 404 });
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        if (this.down) return new Response('down', { status: 503 });
        return Response.json({
          issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks`,
          userinfo_endpoint: `${this.issuer}/userinfo`, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      case '/jwks': return Response.json({ keys: [this.#jwk] });
      case '/token': return this.#token(request);
      case '/userinfo': {
        const account = this.#access.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
        return account === undefined ? new Response('no', { status: 401 }) : Response.json({ sub: account.sub, ...account.claims, ...account.userinfo });
      }
      default: return new Response('not found', { status: 404 });
    }
  };

  /**
   * The person signs in at the provider from the hub's authorization URL: the callback query the provider sends back
   * (a code and the state), or an error the person chose.
   */
  authorize(authorizationUrl: string, account: FakeAccount, error?: string): URLSearchParams {
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get('state') ?? '';
    if (error !== undefined) return new URLSearchParams({ error, error_description: 'The person said no.', state });
    const code = `code-${++this.#counter}`;
    this.#codes.set(code, {
      account, nonce: url.searchParams.get('nonce') ?? '', challenge: url.searchParams.get('code_challenge') ?? '',
      redirect: url.searchParams.get('redirect_uri') ?? '', clientId: url.searchParams.get('client_id') ?? '',
    });
    return new URLSearchParams({ code, state });
  }

  async #token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const granted = this.#codes.get(form.get('code') ?? '');
    const basic = (request.headers.get('authorization') ?? '').replace(/^Basic /, '');
    const [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':').map(decodeURIComponent);
    const verifier = form.get('code_verifier') ?? '';
    if (granted === undefined || id !== this.clientId || secret !== this.clientSecret || granted.clientId !== this.clientId
      || granted.redirect !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== granted.challenge) {
      return Response.json({ error: 'invalid_grant', error_description: 'bad code, client, redirect or verifier' }, { status: 400 });
    }
    this.#codes.delete(form.get('code') ?? '');
    const access = `access-${++this.#counter}`;
    this.#access.set(access, granted.account);
    const now = Math.floor(this.#now() / 1000);
    const idToken = this.#jwt({
      iss: this.issuer, sub: granted.account.sub, aud: this.audience ?? this.clientId, iat: now, exp: now + 300, nonce: granted.nonce, ...granted.account.claims,
    });
    return Response.json({ access_token: access, token_type: 'Bearer', expires_in: 300, id_token: idToken });
  }

  #jwt(claims: Readonly<Record<string, unknown>>): string {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${part({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${part(claims)}`;
    return `${input}.${sign('sha256', Buffer.from(input), this.#key).toString('base64url')}`;
  }
}
