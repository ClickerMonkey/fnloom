/**
 * The mcp module's tunables, an `@ayepi/env` slice. Durations are milliseconds. Boot parses it with the hub's other
 * slices.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Hub MCP tunables. */
export const mcpEnv = env({
  HARNESS_HUB_MCP_MAX_BODY: z.number().int().min(1_024).default(1_048_576).describe('The largest request body a hub MCP accepts, in bytes.'),
  HARNESS_HUB_MCP_ASK_TIMEOUT: z.number().int().min(1_000).default(600_000).describe('How long an MCP call waits for a person\'s approval before it ends as not approved.'),
  HARNESS_HUB_MCP_RUN_TIMEOUT: z.number().int().min(1_000).default(1_800_000).describe('How long one MCP call may take in all.'),
  HARNESS_HUB_MCP_TOKEN_TTL: z.number().int().min(60_000).default(3_600_000).describe('How long a minted MCP session token lasts.'),
  HARNESS_HUB_MCP_RATE: z.number().int().min(1).default(120).describe('Most calls one MCP may start per minute.'),
});

/** The parsed hub MCP tunables. */
export type McpEnv = ReturnType<typeof mcpEnv.parse>;
