/**
 * Build 9: how a system instance signs in to a remote service: an MCP server (`mcp-servers.ts`) or an API service
 * (`programs.ts`). One shape for both, so the add form, the connect flow and the secret handling are written once.
 *
 * - `none`: nothing to send.
 * - `bearer` / `headers`: a token or header values. Shared: an admin types them into the instance's config (sealed as
 *   config secrets, `REMOTE_AUTH_SECRETS`). Per person: each person types their own on the connections page (the
 *   connect `form` flow, `InstanceConnect`), kept as a secret the person owns.
 * - `oauth`: the browser flow through the hub's `/connect/callback`. Per person: each person connects their own
 *   account. Shared: one connection (an admin's) shared with everyone (`ShareRule`).
 */
import { z } from 'zod';
import type { ConfigPath } from './config-secrets.ts';

/** Whose credentials a call uses: one set for everyone (`shared`) or each caller's own (`person`). */
export const RemoteAuthPer = z.enum(['shared', 'person']);
export type RemoteAuthPer = z.infer<typeof RemoteAuthPer>;

/** A header's name (`X-Api-Key`). */
export const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
export type HeaderName = z.infer<typeof HeaderName>;

/** Header values by name. Shared values are config secrets; per-person values are left out here. */
export const HeaderValues = z.record(HeaderName, z.string());
export type HeaderValues = z.infer<typeof HeaderValues>;

/** Nothing to send. */
const NoAuth = z.object({ kind: z.literal('none') });

/** A bearer token. */
const BearerAuth = z.object({
  kind: z.literal('bearer'),
  per: RemoteAuthPer,
  /** The shared token (a config secret); absent for `per: 'person'`. */
  token: z.string().min(1).optional(),
});

/** Header values. */
const HeadersAuth = z.object({
  kind: z.literal('headers'),
  per: RemoteAuthPer,
  /** The header names a person fills in (`per: 'person'`), or the shared values by name (config secrets). */
  names: z.array(HeaderName).min(1),
  values: HeaderValues.optional(),
});

/** The browser sign-in. */
const OAuthAuth = z.object({
  kind: z.literal('oauth'),
  per: RemoteAuthPer,
  /** Scopes to ask for; absent asks for what the server's metadata says it supports. */
  scopes: z.array(z.string().min(1)).optional(),
  /** A client registered by hand; absent, the instance registers itself (OAuth dynamic client registration). */
  clientId: z.string().min(1).optional(),
  /** That client's secret (a config secret), for a confidential client. */
  clientSecret: z.string().min(1).optional(),
});

/** How an instance signs in to its remote service. */
export const RemoteAuth = z.discriminatedUnion('kind', [NoAuth, BearerAuth, HeadersAuth, OAuthAuth]);
export type RemoteAuth = z.infer<typeof RemoteAuth>;

/**
 * The sign-ins that need no browser flow: none, a token or header values. A service whose OAuth endpoints are not
 * found from the server itself (an API service, unlike an MCP server) signs in with one of these.
 */
export const TypedAuth = z.discriminatedUnion('kind', [NoAuth, BearerAuth, HeadersAuth]);
export type TypedAuth = z.infer<typeof TypedAuth>;

/** The config paths (under an instance's `auth` field) that hold a `TypedAuth`'s secrets. */
export const TYPED_AUTH_SECRETS = ['auth.token', 'auth.values'] as const satisfies readonly ConfigPath[];

/** The config paths (under an instance's `auth` field) that hold secrets: sealed by the hub, never shown again. */
export const REMOTE_AUTH_SECRETS = ['auth.token', 'auth.values', 'auth.clientSecret'] as const satisfies readonly ConfigPath[];

/**
 * What a person connects with for an auth that is per person (or an OAuth shared through one connection): the connect
 * flow it maps to. `undefined` when calls need no connection at all.
 */
export function connectFlowOf(auth: RemoteAuth): 'oauth' | 'form' | undefined {
  if (auth.kind === 'oauth') return 'oauth';
  if (auth.kind === 'none' || auth.per === 'shared') return undefined;
  return 'form';
}

/** Per-person credentials kept by the hub for a `form` connection: the token or the header values the person typed. */
export const RemoteCredentials = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({ headers: HeaderValues }),
  /** OAuth tokens, refreshed by the instance and handed back with `connectionUpdate`. */
  z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    tokenType: z.string().default('Bearer'),
    /** The client the tokens were issued to (one the instance registered itself), needed to refresh them. */
    clientId: z.string().min(1).optional(),
  }),
]);
export type RemoteCredentials = z.infer<typeof RemoteCredentials>;
