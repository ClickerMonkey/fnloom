/**
 * Signing in to an MCP server with OAuth, through the hub's connect flow, on `@ayepi/mcp`'s authorization client: the
 * server's challenge or `.well-known` names its authorization server; the instance uses the admin's client or
 * registers one itself; the person goes to the PKCE authorization URL with the server as the `resource`; the code that
 * comes back is exchanged for tokens, kept by the hub as the person's connection (core's `RemoteCredentials`, with the
 * client they were issued to) and refreshed here when the server refuses them. The PKCE verifier waits in this process
 * between the two halves of the flow; a restart in between means signing in again.
 */
import {
  OAuthError, authorizationUrl, discoverAuthorizationServer, discoverProtectedResource, exchangeCode, makePkce, parseBearerChallenge, refreshTokens, registerClient,
  resourceOf, tokensExpireAt, type AuthorizationServerMetadata, type BearerChallenge, type OAuthClient, type OAuthTokens,
} from '@ayepi/mcp';
import { messageOf, type ConnectFinish, type ConnectStart, type RemoteAuth, type RemoteCredentials } from '@harness/core';
import type { McpProtocolVersion } from '@ayepi/mcp';

/** The OAuth auth of an instance. */
export type OAuthAuth = Extract<RemoteAuth, { kind: 'oauth' }>;

/** Credentials a sign-in or a refresh made, and when they lapse. */
export interface SignedIn {
  readonly credentials: RemoteCredentials;
  readonly expiresAt?: number;
}

/** The half-finished sign-in of one connection. */
interface Pending {
  readonly verifier: string;
  readonly client: OAuthClient;
  readonly redirect: string;
}

/** What the authorization server and the scope come to for a server. */
interface Discovered {
  readonly metadata: AuthorizationServerMetadata;
  readonly scope: string | undefined;
}

/** The protocol version the probe for a challenge says it speaks. */
const PROBE_VERSION: McpProtocolVersion = '2025-06-18';

/** OAuth sign-in to one MCP server. */
export class OAuthSignIn {
  readonly #server: string;
  readonly #auth: OAuthAuth;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  readonly #clients = new Map<string, OAuthClient>();
  #discovered: Promise<Discovered> | undefined;

  constructor(server: string, auth: OAuthAuth, options: { readonly fetch: typeof fetch; readonly now: () => number }) {
    this.#server = server;
    this.#auth = auth;
    this.#fetch = options.fetch;
    this.#now = options.now;
  }

  /** Where to send the person: the authorization server's page, coming back to the hub's redirect with `state`. */
  async start(request: Pick<ConnectStart, 'connection' | 'redirect' | 'state'>): Promise<{ url: string }> {
    const { metadata, scope } = await this.#discover();
    const client = await this.#client(metadata, request.redirect, scope);
    const pkce = await makePkce();
    this.#pending.set(request.connection, { verifier: pkce.verifier, client, redirect: request.redirect });
    const url = authorizationUrl(metadata, {
      clientId: client.client_id, redirectUri: request.redirect, challenge: pkce.challenge, state: request.state, resource: resourceOf(this.#server),
      ...(scope === undefined ? {} : { scope }),
    });
    return { url };
  }

  /** The tokens for the code the redirect brought, or the problem in words. */
  async finish(request: Pick<ConnectFinish, 'connection' | 'answer'>): Promise<SignedIn | { readonly problem: string }> {
    if (!('params' in request.answer)) { return { problem: 'This server signs in through its own page, not a form.' }; }
    const pending = this.#pending.get(request.connection);
    this.#pending.delete(request.connection);
    const { error, code } = request.answer.params;
    if (error !== undefined) { return { problem: error === 'access_denied' ? 'You didn\'t allow access.' : `The server said: ${error}.` }; }
    if (code === undefined || code === '') { return { problem: 'The server sent no code back; try signing in again.' }; }
    if (pending === undefined) { return { problem: 'This sign-in was started before a restart; start it again.' }; }
    try {
      const { metadata } = await this.#discover();
      const tokens = await exchangeCode(metadata, this.#tokenClient(pending.client), {
        code, verifier: pending.verifier, redirectUri: pending.redirect, resource: resourceOf(this.#server),
      }, { fetch: this.#fetch });
      return this.#signedIn(tokens, pending.client.client_id, undefined);
    } catch (problem) {
      if (problem instanceof OAuthError) { return { problem: `Signing in failed: ${problem.message}` }; }
      throw problem;
    }
  }

  /** Fresh tokens for OAuth credentials with a refresh token; `undefined` when they can't be refreshed. */
  async refresh(credentials: RemoteCredentials): Promise<SignedIn | undefined> {
    if (!('accessToken' in credentials) || credentials.refreshToken === undefined) { return undefined; }
    const clientId = credentials.clientId ?? this.#auth.clientId;
    if (clientId === undefined) { return undefined; }
    try {
      const { metadata, scope } = await this.#discover();
      const tokens = await refreshTokens(metadata, this.#tokenClient({ client_id: clientId }), {
        refreshToken: credentials.refreshToken, resource: resourceOf(this.#server), ...(scope === undefined ? {} : { scope }),
      }, { fetch: this.#fetch });
      return this.#signedIn(tokens, clientId, credentials.refreshToken);
    } catch (problem) {
      if (problem instanceof OAuthError) { return undefined; }
      throw problem;
    }
  }

  #signedIn(tokens: OAuthTokens, clientId: string, previousRefresh: string | undefined): SignedIn {
    const refreshToken = tokens.refresh_token ?? previousRefresh;
    const expiresAt = tokensExpireAt(tokens, this.#now());
    return {
      credentials: { accessToken: tokens.access_token, tokenType: tokens.token_type, clientId, ...(refreshToken === undefined ? {} : { refreshToken }) },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  /** The admin's client (with its secret), else the one this instance registered. */
  #tokenClient(client: OAuthClient): { clientId: string; clientSecret?: string } {
    const secret = client.client_id === this.#auth.clientId ? this.#auth.clientSecret : client.client_secret;
    return { clientId: client.client_id, ...(secret === undefined ? {} : { clientSecret: secret }) };
  }

  /** The admin's client, else one registered for this redirect (once per process). */
  async #client(metadata: AuthorizationServerMetadata, redirect: string, scope: string | undefined): Promise<OAuthClient> {
    if (this.#auth.clientId !== undefined) { return { client_id: this.#auth.clientId, ...(this.#auth.clientSecret === undefined ? {} : { client_secret: this.#auth.clientSecret }) }; }
    const known = this.#clients.get(redirect);
    if (known !== undefined) { return known; }
    const registered = await registerClient(metadata, { redirectUris: [redirect], clientName: 'Harness', ...(scope === undefined ? {} : { scope }) }, { fetch: this.#fetch });
    this.#clients.set(redirect, registered);
    return registered;
  }

  /** The server's authorization server and the scope to ask for (found once; looked for again after a failure). */
  #discover(): Promise<Discovered> {
    this.#discovered ??= this.#find().catch((error: unknown) => {
      this.#discovered = undefined;
      throw error instanceof OAuthError ? error : new OAuthError('no_metadata', messageOf(error));
    });
    return this.#discovered;
  }

  async #find(): Promise<Discovered> {
    const challenge = await this.#challenge();
    const resource = await discoverProtectedResource(this.#server, challenge, { fetch: this.#fetch });
    const issuer = resource.authorization_servers[0] ?? this.#server;
    const metadata = await discoverAuthorizationServer(issuer, { fetch: this.#fetch });
    const scope = this.#auth.scopes?.join(' ') ?? challenge.scope ?? resource.scopes_supported?.join(' ');
    return { metadata, scope };
  }

  /** What the server says when asked without credentials (its `WWW-Authenticate` challenge); `{}` when it says nothing. */
  async #challenge(): Promise<BearerChallenge> {
    const response = await this.#fetch(this.#server, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROBE_VERSION, capabilities: {}, clientInfo: { name: 'harness', version: '0' } } }),
    });
    await response.body?.cancel();
    const header = response.status === 401 ? response.headers.get('www-authenticate') : null;
    return (header === null ? undefined : parseBearerChallenge(header)) ?? {};
  }
}
