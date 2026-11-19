/**
 * A small OAuth 2.1 authorization server for the test server. `@ayepi/mcp` has the client side of MCP authorization
 * (discovery, registration, PKCE, token exchange) but no server side, so the endpoints the client calls live here:
 *
 * - `GET  /.well-known/oauth-protected-resource`: RFC 9728 metadata, naming this server as its authorization server.
 * - `GET  /.well-known/oauth-authorization-server`: RFC 8414 metadata.
 * - `POST /register`: RFC 7591 dynamic client registration (public clients).
 * - `GET  /authorize`: authorization code with PKCE (S256). It approves at once, with no login page.
 * - `POST /token`: `authorization_code` and `refresh_token` grants.
 *
 * Access tokens are opaque and live `ttlSeconds`. Protected routes answer a missing or expired token with a 401 whose
 * `WWW-Authenticate` names the protected resource metadata, which is how a client finds this server.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { bearerToken, type McpAuthDecision, type McpAuthorizer } from '@ayepi/mcp';

interface Client { readonly name: string; readonly redirectUris: readonly string[] }
interface Code { readonly clientId: string; readonly redirectUri: string; readonly challenge: string; readonly subject: string; readonly expires: number }
interface Grant { readonly subject: string; readonly clientId: string; readonly expires: number }

const SCOPE = 'mcp';
const CODE_TTL_SECONDS = 60;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const oauthError = (error: string, description: string, status = 400): Response => json({ error, error_description: description }, status);

const now = (): number => Math.floor(Date.now() / 1000);

/** The base64url SHA-256 of a PKCE verifier. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export class TestOAuthServer implements McpAuthorizer {
  readonly #resourcePath: string;
  readonly #ttl: number;
  readonly #clients = new Map<string, Client>();
  readonly #codes = new Map<string, Code>();
  readonly #access = new Map<string, Grant>();
  readonly #refresh = new Map<string, Omit<Grant, 'expires'>>();

  /** `resourcePath`: the protected endpoint this server issues tokens for (`/mcp` or `/sse`). */
  constructor(resourcePath: string, ttlSeconds: number) {
    this.#resourcePath = resourcePath;
    this.#ttl = ttlSeconds;
  }

  /** Answers the authorization server's own routes; `undefined` for any other path. */
  async route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const origin = url.origin;
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource':
        return json({ resource: `${origin}${this.#resourcePath}`, authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: [SCOPE] });
      case '/.well-known/oauth-authorization-server':
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
          scopes_supported: [SCOPE],
        });
      case '/register':
        return request.method === 'POST' ? this.#register(request) : undefined;
      case '/authorize':
        return request.method === 'GET' ? this.#authorize(url) : undefined;
      case '/token':
        return request.method === 'POST' ? this.#token(request) : undefined;
      default:
        return undefined;
    }
  }

  /** Protected routes: a live access token is the caller. */
  async authorize(request: Request): Promise<McpAuthDecision> {
    const challenge = `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource"`;
    const token = bearerToken(request);
    if (token === undefined) {
      return { ok: false, status: 401, message: 'sign in with OAuth first', challenge };
    }
    const grant = this.#access.get(token);
    if (grant === undefined || grant.expires <= now()) {
      return { ok: false, status: 401, message: 'invalid or expired access token', challenge: `${challenge}, error="invalid_token"` };
    }
    return { ok: true, auth: { subject: grant.subject, scopes: [SCOPE] } };
  }

  async #register(request: Request): Promise<Response> {
    const body = await readJson(request);
    const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
    if (redirectUris.length === 0) {
      return oauthError('invalid_client_metadata', 'redirect_uris must be a non-empty array');
    }
    const clientId = randomUUID();
    const name = typeof body?.client_name === 'string' ? body.client_name : 'unnamed client';
    this.#clients.set(clientId, { name, redirectUris });
    return json({
      client_id: clientId,
      client_id_issued_at: now(),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, 201);
  }

  #authorize(url: URL): Response {
    const params = url.searchParams;
    const client = this.#clients.get(params.get('client_id') ?? '');
    const redirectUri = params.get('redirect_uri') ?? '';
    // Without a known client and a registered redirect URI there is nowhere safe to send the person.
    if (client === undefined || !client.redirectUris.includes(redirectUri)) {
      return oauthError('invalid_request', 'unknown client or unregistered redirect_uri');
    }
    const back = new URL(redirectUri);
    const fail = (error: string): Response => {
      back.searchParams.set('error', error);
      copyState(params, back);
      return Response.redirect(back.href, 302);
    };
    if (params.get('response_type') !== 'code') { return fail('unsupported_response_type'); }
    if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) { return fail('invalid_request'); }
    const code = randomBytes(24).toString('base64url');
    this.#codes.set(code, {
      clientId: params.get('client_id') ?? '',
      redirectUri,
      challenge: params.get('code_challenge') ?? '',
      subject: `oauth:${client.name}`,
      expires: now() + CODE_TTL_SECONDS,
    });
    back.searchParams.set('code', code);
    copyState(params, back);
    return Response.redirect(back.href, 302);
  }

  async #token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const basic = clientFromBasic(request.headers.get('authorization'));
    const clientId = basic?.id ?? form.get('client_id') ?? '';
    if (!this.#clients.has(clientId)) { return oauthError('invalid_client', 'unknown client', 401); }

    if (form.get('grant_type') === 'authorization_code') {
      const code = this.#codes.get(form.get('code') ?? '');
      this.#codes.delete(form.get('code') ?? '');
      if (code === undefined || code.expires <= now() || code.clientId !== clientId) {
        return oauthError('invalid_grant', 'unknown, expired or foreign authorization code');
      }
      if (form.get('redirect_uri') !== code.redirectUri) { return oauthError('invalid_grant', 'redirect_uri does not match'); }
      if (s256(form.get('code_verifier') ?? '') !== code.challenge) { return oauthError('invalid_grant', 'PKCE verifier does not match'); }
      return this.#issue(code.subject, clientId);
    }

    if (form.get('grant_type') === 'refresh_token') {
      const old = this.#refresh.get(form.get('refresh_token') ?? '');
      if (old === undefined || old.clientId !== clientId) { return oauthError('invalid_grant', 'unknown refresh token'); }
      this.#refresh.delete(form.get('refresh_token') ?? '');
      return this.#issue(old.subject, clientId);
    }

    return oauthError('unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  #issue(subject: string, clientId: string): Response {
    const access = randomBytes(32).toString('base64url');
    const refresh = randomBytes(32).toString('base64url');
    this.#access.set(access, { subject, clientId, expires: now() + this.#ttl });
    this.#refresh.set(refresh, { subject, clientId });
    return json({ access_token: access, token_type: 'Bearer', expires_in: this.#ttl, refresh_token: refresh, scope: SCOPE });
  }
}

/** The JSON body of a request, or `undefined` when it is not a JSON object. */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await request.text());
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The client id and secret of an HTTP Basic `Authorization` header. */
function clientFromBasic(header: string | null): { id: string } | undefined {
  if (header === null || !header.startsWith('Basic ')) { return undefined; }
  const [id] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return id === undefined || id === '' ? undefined : { id };
}

/** Carries `state` from the authorization request back to the redirect, as OAuth requires. */
function copyState(from: URLSearchParams, to: URL): void {
  const state = from.get('state');
  if (state !== null) { to.searchParams.set('state', state); }
}
