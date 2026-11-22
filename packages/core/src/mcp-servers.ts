/**
 * Build 9: the `mcp` system, the harness as an MCP client. Each MCP server a person adds is an instance of the bundled
 * `mcp` system (config `McpServerConfig`). The instance connects with `@ayepi/mcp`'s `McpClient`, and mirrors the
 * server live into the hub with the runtime add/update/remove API:
 *
 * - each tool is a fn of kind `MCP_TOOL_KIND` named `<instance>_<tool>`, runs on that instance, with the server's
 *   annotations read as effects (never trusted to lower an approval unless the admin marked the server `trusted`);
 * - each prompt is a context item with a `/command` (its arguments as the command's args);
 * - each resource is a resource under the instance's root `mcp://<instance>/`, read through the server.
 *
 * Elicitations the server sends during a call become a form on the call's approval card (`ProposeRun.ask`).
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { InstanceName, Json, Timestamp } from './primitives.ts';
import { FnLocalName } from './model-names.ts';
import { RemoteAuth, REMOTE_AUTH_SECRETS } from './remote-auth.ts';
import type { ConfigPath } from './config-secrets.ts';

/** The bundled system every MCP server is an instance of. */
export const MCP_SYSTEM = 'mcp';
/** The kind of a fn that mirrors one MCP tool. */
export const MCP_TOOL_KIND = 'mcp/tool';

/** An environment variable for a stdio server, by name. */
export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** How the instance reaches the server. */
export const McpTransport = z.discriminatedUnion('type', [
  /** A local process the instance starts (admins only; it runs on the instance's machine). */
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Environment values by name (config secrets: the MCP spec says stdio servers take credentials this way). */
    env: z.record(EnvName, z.string()).optional(),
    cwd: z.string().min(1).optional(),
  }),
  /** Streamable HTTP (MCP 2025-03-26 and later). */
  z.object({ type: z.literal('http'), url: z.url() }),
  /** The older HTTP + SSE transport (MCP 2024-11-05). */
  z.object({ type: z.literal('sse'), url: z.url() }),
]);
export type McpTransport = z.infer<typeof McpTransport>;

/** Which calls of the server's tools wait for approval. `writes`: every tool not marked read-only (by a trusted server). */
export const McpApproval = z.enum(['always', 'writes', 'never']);
export type McpApproval = z.infer<typeof McpApproval>;

/** One MCP server: the config of its `mcp` instance. */
export const McpServerConfig = z.object({
  /** The name people see ("Linear"). The instance name is the fn prefix. */
  label: z.string().min(1),
  description: z.string().optional(),
  transport: McpTransport,
  /** How it signs in; stdio servers use `none` and take credentials in `transport.env`. */
  auth: RemoteAuth.default({ kind: 'none' }),
  /** Whether the server's own annotations (`readOnlyHint`, `destructiveHint`) may lower the approval gate. */
  trusted: z.boolean().default(false),
  approval: McpApproval.default('writes'),
  /** Mirror its prompts as `/commands` and its resources as hub resources. */
  prompts: z.boolean().default(true),
  resources: z.boolean().default(true),
  /** Tools beyond this many are left out (and reported on the server's status). */
  maxTools: z.number().int().min(1).max(1000).default(200),
  /** How long one call may take, in milliseconds. */
  timeout: z.number().int().min(1000).default(120_000),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** The secret config paths of an MCP server instance. */
export const MCP_CONFIG_SECRETS = ['transport.env', ...REMOTE_AUTH_SECRETS] as const satisfies readonly ConfigPath[];

/** Where an MCP instance is with its server. */
export const McpServerState = z.enum(['connecting', 'connected', 'needs-auth', 'unreachable', 'failed']);
export type McpServerState = z.infer<typeof McpServerState>;

/** An MCP server's status (fn `mcp/server_status`, shown on the MCP servers page). */
export const McpServerStatus = z.object({
  instance: InstanceName,
  state: McpServerState,
  /** What the server said about itself at `initialize`. */
  server: z.object({ name: z.string(), version: z.string(), protocol: z.string(), instructions: z.string().optional() }).optional(),
  tools: z.number().int().min(0),
  prompts: z.number().int().min(0),
  resources: z.number().int().min(0),
  /** Tools whose input schema did not map to a gin type cleanly (taken as any JSON, checked by the server). */
  degraded: z.array(z.string()),
  /** Tools left out past `maxTools`. */
  leftOut: z.number().int().min(0),
  problem: z.string().optional(),
  checkedAt: Timestamp,
});
export type McpServerStatus = z.infer<typeof McpServerStatus>;

/** MCP's tool annotations, as the server sent them (untrusted unless the server is `trusted`). */
export const McpToolAnnotations = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpToolAnnotations = z.infer<typeof McpToolAnnotations>;

/** The payload of a fn of kind `mcp/tool`: the mirror of the remote declaration. The kind derives the rest. */
export const McpToolSpec = z.object({
  /** The tool's name on the server. */
  tool: z.string().min(1),
  description: z.string(),
  /** The server's JSON Schemas, kept as sent. */
  inputSchema: Json,
  outputSchema: Json.optional(),
  /** The gin type read off `inputSchema` (any JSON where it did not map; `degraded` then says why). */
  args: GinTypeDef,
  returns: GinTypeDef.optional(),
  annotations: McpToolAnnotations.optional(),
  degraded: z.string().optional(),
});
export type McpToolSpec = z.infer<typeof McpToolSpec>;

/**
 * The fn name of an MCP tool: `<instance>_<tool>`, with characters a fn name can't hold made `_`, and runs of `_` (and
 * a part's leading or trailing ones) folded, so its model name reads back (`FnLocalName`).
 */
export function mcpToolFnName(instance: InstanceName, tool: string): string {
  const raw = `${instance}_${tool.replace(/[^A-Za-z0-9_.-]/g, '_')}`.replace(/-/g, '_');
  return FnLocalName.parse(raw.split('.').map((part) => part.replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'x').join('.'));
}

/** The resource root of an MCP instance's resources: `mcp://<instance>/`. */
export function mcpRootOf(instance: InstanceName): string {
  return `mcp://${instance}/`;
}
