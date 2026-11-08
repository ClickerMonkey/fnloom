/**
 * The mcp module (hub-platform lane): hub MCPs, admin-made MCP endpoints served at `/mcp/<slug>` on the hub's HTTP
 * front with `@ayepi/mcp` (`McpRouter`, one `mcpSourceServer` per MCP, `BearerAuth`-style secrets looked up by
 * digest). Every tool call is a real run through `RunService`: the MCP's person's permissions, budgets and approvals,
 * attributed to its `mcp` actor, recorded and metered like any run.
 *
 * - `McpRegistry` keeps the records and secrets (shown once at create and rotate; only the digest is stored).
 * - `McpScopes` resolves rules live, on every list and every call: a fn is exposed when available, selected by
 *   `include`, not by `exclude`, and not tagged `admin`; a type when selected or needed by an exposed fn's signature;
 *   context only bringing exposed fns; resources by prefix. A hidden tool is a refused tool.
 * - `McpEndpoints` mounts the servers and answers HTTP; tool sources are `each` (one tool per fn, `<system>_<local>`)
 *   or `static` (the chat's static toolset, scoped to the MCP). Outcomes map to MCP results: done → structured
 *   content, invalid input → `isError` with the problems (the model can correct them), failed or cancelled →
 *   `isError`; an approval wait keeps the call open until `HARNESS_HUB_MCP_ASK_TIMEOUT`.
 * - `McpTokens` mints short-lived session tokens for grantee systems (`hub/mint_mcp_token`), so a Claude system can
 *   give each Claude Code session its own labelled credential without the secret leaving the hub.
 *
 * Tunables are the `mcpEnv` slice (`env.ts`).
 */
import type { ActorId, HubMcp, HubMcpId, HubMcpInput, HubMcpView, McpSlug, McpRules, McpScopePreview, McpSessionView, McpTokenClaims, QualifiedName, SystemName } from '@harness/core';

/** Hub MCP records and their secrets. */
export interface McpRegistry {
  list(): Promise<HubMcpView[]>;
  get(mcp: HubMcpId): Promise<HubMcpView | undefined>;
  /** The stored record (with its secret's digest), for the hub's own use. */
  record(mcp: HubMcpId): Promise<HubMcp | undefined>;
  /** The record at a route. */
  bySlug(slug: McpSlug): Promise<HubMcp | undefined>;
  /** Make an MCP (and its `mcp` actor); the secret is returned this once. */
  create(input: HubMcpInput, by: ActorId): Promise<{ mcp: HubMcpView; secret: string }>;
  update(mcp: HubMcpId, change: Partial<HubMcpInput>, by: ActorId): Promise<HubMcpView>;
  /** A new secret; every open session of the MCP ends. */
  rotate(mcp: HubMcpId, by: ActorId): Promise<{ secret: string }>;
  remove(mcp: HubMcpId, by: ActorId): Promise<boolean>;
}

/** What an MCP exposes now. */
export interface McpScope {
  readonly fns: ReadonlySet<QualifiedName>;
  readonly types: ReadonlySet<QualifiedName>;
  readonly context: ReadonlySet<QualifiedName>;
  /** Whether a resource URI is inside the exposed prefixes. */
  allowsResource(uri: string): boolean;
}

/** Rules into scopes, resolved live from the catalog (cached by MCP update time and catalog version). */
export interface McpScopes {
  scope(mcp: HubMcpId): Promise<McpScope>;
  /** What draft rules would expose, with the closure and warnings, for the admin page. */
  preview(rules: McpRules): Promise<McpScopePreview>;
}

/** The `/mcp/<slug>` endpoints. */
export interface McpEndpoints {
  /** Answer one HTTP request under `/mcp` (Streamable HTTP: JSON or SSE). Unknown slug, disabled MCP and bad bearer look alike. */
  handle(request: Request): Promise<Response>;
  sessions(mcp: HubMcpId): Promise<McpSessionView[]>;
  /** Mount every enabled MCP (on start); later changes remount each as it changes. Returns the stop. */
  start(): Promise<() => void>;
}

/** Short-lived session tokens minted from an MCP for its grantee systems. */
export interface McpTokens {
  /** Refused unless the system is one of the MCP's grantees. `ttl` is capped at `HARNESS_HUB_MCP_TOKEN_TTL`. */
  mint(input: { mcp: HubMcpId; label: string; ttl: number; system: SystemName }): Promise<{ token: string; expiresAt: number }>;
  verify(token: string): Promise<McpTokenClaims | undefined>;
}

/** The mcp module's services (`HubServices.mcp`). */
export interface McpServices {
  readonly registry: McpRegistry;
  readonly scopes: McpScopes;
  readonly endpoints: McpEndpoints;
  readonly tokens: McpTokens;
}
