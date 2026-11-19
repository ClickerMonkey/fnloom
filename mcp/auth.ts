/**
 * The sign-in methods the test server can require, each as an `McpAuthorizer` the transports call before they read a
 * request body:
 *
 * - `none`: nobody is asked for anything.
 * - `token`: `Authorization: Bearer <token>` (the library's `BearerAuth`).
 * - `headers`: every configured header must be sent with the configured value.
 * - `oauth`: a small authorization server (`oauth.ts`) that signs a client in with PKCE and issues bearer tokens.
 */
import { BearerAuth, type McpAuthDecision, type McpAuthInfo, type McpAuthorizer } from '@ayepi/mcp';

export const AUTH_MODES = ['none', 'token', 'headers', 'oauth'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Sign-in settings from the command line (or their defaults). */
export interface AuthSettings {
  readonly mode: AuthMode;
  /** The bearer token `token` mode accepts. */
  readonly token: string;
  /** The header names and values `headers` mode requires. */
  readonly headers: Readonly<Record<string, string>>;
}

export const DEFAULT_TOKEN = 'test-token';
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = { 'X-Api-Key': 'test-key' };

/** The response a refused request gets: the library's shape (a JSON-RPC error body), plus the challenge. */
export function refusal(decision: Extract<McpAuthDecision, { ok: false }>): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (decision.challenge !== undefined) { headers['www-authenticate'] = decision.challenge; }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: decision.message } }), {
    status: decision.status,
    headers,
  });
}

/** Lets a request in (its caller, when there is a sign-in) or answers the refusal. */
export type Admission = { readonly ok: true; readonly auth: McpAuthInfo | undefined } | { readonly ok: false; readonly response: Response };

/** Runs the authorizer on a request. With no authorizer everyone is let in with no caller. */
export async function admit(authorizer: McpAuthorizer | undefined, request: Request): Promise<Admission> {
  if (authorizer === undefined) { return { ok: true, auth: undefined }; }
  const decision = await authorizer.authorize(request);
  return decision.ok ? { ok: true, auth: decision.auth } : { ok: false, response: refusal(decision) };
}

/** `headers` mode: every expected header present with its value. The first header's value is the subject. */
export class HeaderAuth implements McpAuthorizer {
  readonly #expected: readonly (readonly [string, string])[];

  constructor(expected: Readonly<Record<string, string>>) {
    this.#expected = Object.entries(expected);
  }

  async authorize(request: Request): Promise<McpAuthDecision> {
    const missing = this.#expected.filter(([name]) => request.headers.get(name) === null).map(([name]) => name);
    if (missing.length > 0) {
      return { ok: false, status: 401, message: `missing header(s): ${missing.join(', ')}` };
    }
    const wrong = this.#expected.filter(([name, value]) => request.headers.get(name) !== value).map(([name]) => name);
    if (wrong.length > 0) {
      return { ok: false, status: 403, message: `wrong value for header(s): ${wrong.join(', ')}` };
    }
    const [first] = this.#expected[0] ?? [''];
    return { ok: true, auth: { subject: request.headers.get(first) ?? '', scopes: [] } };
  }
}

/** The authorizer for a `token` or `headers` sign-in. `oauth` builds its own (see `oauth.ts`). */
export function staticAuthorizer(settings: AuthSettings): McpAuthorizer | undefined {
  switch (settings.mode) {
    case 'none':
    case 'oauth':
      return undefined;
    case 'token':
      return new BearerAuth([{ secret: settings.token, subject: 'token-user', scopes: ['mcp'] }], { realm: 'harness-test' });
    case 'headers':
      return new HeaderAuth(settings.headers);
  }
}
