/**
 * The MCP system's tunables, an `@ayepi/env` slice. The server itself (transport, auth, call timeout) is the
 * instance's config, not here. Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const mcpEnv = env({
  ...systemFields(),
  /** How long connecting to a server (the `initialize` handshake) may take. */
  MCP_CONNECT_TIMEOUT: z.number().int().min(1_000).default(20_000),
  /** The first wait before reconnecting to a server that went away; it doubles up to `MCP_RECONNECT_MAX`. */
  MCP_RECONNECT_MIN: z.number().int().min(10).default(1_000),
  MCP_RECONNECT_MAX: z.number().int().min(100).default(60_000),
  /** How often a connected server is pinged to notice it went away (0: never). */
  MCP_PING_EVERY: z.number().int().min(0).default(30_000),
  /** Mirror again this long after the last `list_changed` notice, so a burst of them is one mirror. */
  MCP_MIRROR_SETTLE: z.number().int().min(0).default(250),
  /** A person's own connection to a server is closed after this long unused (shared ones stay open). */
  MCP_IDLE_CLOSE: z.number().int().min(1_000).default(10 * 60_000),
  /** Text a resource read or a prompt gives the hub, at most (longer is cut, and says so). */
  MCP_MAX_TEXT: z.number().int().min(1_000).default(2_000_000),
}).add(systemState('mcp'));

/** The system's settings, resolved. */
export type McpSettings = ReturnType<typeof mcpEnv.parse>;
