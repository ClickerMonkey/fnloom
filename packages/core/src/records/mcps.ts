/**
 * Hub MCPs: MCP endpoints an admin makes on the hub, each at its own route (`/mcp/<slug>`) with its own secret and
 * include/exclude rules over systems, fns, types, context and resources. An MCP client (a Claude Code session the
 * Claude system started, say) reaches the hub through one, and every tool call is a real run: policies, approvals,
 * budgets, the ledger and metrics apply, attributed to the MCP's actor and run for its person.
 */
import { z } from 'zod';
import { ActorId, HubMcpId, InstanceName, NameGlob, QualifiedName, SYSTEM_NAME_PATTERN, SystemName, Timestamp } from '../primitives.ts';
import { FnMatch } from './actors.ts';

/** An MCP's route: `/mcp/<slug>`. Lowercase letters, digits and dashes, starting with a letter. */
export const McpSlug = z.string().regex(SYSTEM_NAME_PATTERN).max(64).brand<'McpSlug'>();
export type McpSlug = z.infer<typeof McpSlug>;

/** A resource prefix an MCP selects: a URI prefix, optionally only on one system or instance. */
export const ResourceSelector = z.object({ uri: z.string(), system: SystemName.optional(), instance: InstanceName.optional() });
export type ResourceSelector = z.infer<typeof ResourceSelector>;

/**
 * What a rule selects. Every list is optional; an empty selector selects nothing. `systems` selects whole systems
 * (their fns, types, context and resources); `fns` uses the policies' matcher, so "which fns" has one shape.
 */
export const McpSelector = z.object({
  systems: z.array(SystemName).optional(),
  fns: z.array(FnMatch).optional(),
  types: z.array(NameGlob).optional(),
  context: z.array(NameGlob).optional(),
  resources: z.array(ResourceSelector).optional(),
});
export type McpSelector = z.infer<typeof McpSelector>;

/** What an MCP exposes: what `include` selects and `exclude` doesn't. Fns tagged `admin` are never exposed. */
export const McpRules = z.object({ include: McpSelector, exclude: McpSelector });
export type McpRules = z.infer<typeof McpRules>;

/** How fns are offered: one MCP tool per fn, or the static toolset (`find`, `inspect`, `run`) over the exposed set. */
export const MCP_TOOL_MODES = ['each', 'static'] as const;
export const McpToolMode = z.enum(MCP_TOOL_MODES);
export type McpToolMode = z.infer<typeof McpToolMode>;

/** One hub MCP. The secret itself is shown once, when it is made or rotated; only its digest is kept. */
export const HubMcp = z.object({
  id: HubMcpId,
  slug: McpSlug,
  name: z.string().min(1),
  /** Sent as the MCP `instructions` on initialize. */
  instructions: z.string(),
  rules: McpRules,
  toolMode: McpToolMode,
  /** The person whose permissions, budgets and approvals its runs use. */
  user: ActorId,
  /** The actor its runs are attributed to (an `mcp` actor), so policies can target it. */
  actor: ActorId,
  /** sha-256 of the endpoint secret (`hmcp_…`), hex. */
  secretDigest: z.string(),
  /** Systems allowed to mint short-lived session tokens for it (`hub/mint_mcp_token`): the Claude system. */
  grantees: z.array(SystemName),
  /** Browser origins allowed; none means requests without an `Origin` header only. */
  origins: z.array(z.string()),
  enabled: z.boolean(),
  createdBy: ActorId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type HubMcp = z.infer<typeof HubMcp>;

/** What an admin sends to make or change an MCP (the hub fills ids, actor, digest and times). */
export const HubMcpInput = HubMcp.pick({ slug: true, name: true, instructions: true, rules: true, toolMode: true, user: true, grantees: true, origins: true, enabled: true });
export type HubMcpInput = z.infer<typeof HubMcpInput>;

/** The claims of a session token minted from an MCP: which MCP, a label for its runs (`claude session 3`), and expiry. */
export const McpTokenClaims = z.object({ mcp: HubMcpId, label: z.string().min(1), exp: z.number().int() });
export type McpTokenClaims = z.infer<typeof McpTokenClaims>;

/**
 * What an MCP's rules resolve to now: every exposed fn, type, context item and resource root, the types pulled in
 * because an exposed fn needs them, and warnings (an excluded type an exposed fn needs; a context item that would
 * bring a fn that isn't exposed). The admin page shows it before saving.
 */
export const McpScopePreview = z.object({
  fns: z.array(QualifiedName),
  types: z.array(QualifiedName),
  /** Types exposed only because an exposed fn's signature needs them. */
  closure: z.array(QualifiedName),
  context: z.array(QualifiedName),
  resources: z.array(ResourceSelector),
  /** Fns an exposed fn may call (they run under the same grant). */
  reach: z.array(QualifiedName),
  warnings: z.array(z.string()),
});
export type McpScopePreview = z.infer<typeof McpScopePreview>;

/** An open session on an MCP: its label (from a session token, or `secret`), the client it said it was, and use. */
export const McpSessionView = z.object({
  mcp: HubMcpId,
  session: z.string(),
  label: z.string(),
  client: z.object({ name: z.string(), version: z.string() }).optional(),
  since: Timestamp,
  lastCallAt: Timestamp.optional(),
  calls: z.number().int().min(0),
});
export type McpSessionView = z.infer<typeof McpSessionView>;

/** An MCP as the admin list shows it. */
export const HubMcpView = HubMcp.omit({ secretDigest: true }).extend({
  url: z.string(),
  sessions: z.number().int().min(0),
  callsToday: z.number().int().min(0),
});
export type HubMcpView = z.infer<typeof HubMcpView>;
