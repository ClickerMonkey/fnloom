/**
 * The mcp module's hub fns: `hub/mint_mcp_token`, the short-lived session token a grantee system (a Claude system)
 * gives each session it starts. Only a run a grantee system's fn called may mint one; the admin fns over hub MCPs
 * (`hub/create_mcp`, …) are admin operations (`boot/admin-fns.ts`).
 */
import { HubMcpId, SystemName } from '@harness/core';
import { z } from 'zod';
import { hub } from '@harness/sdk';
import type { HubFns } from '../execution/executors.ts';
import type { McpEnv } from './env.ts';
import type { McpTokens } from './index.ts';

/**
 * The args of `hub/mint_mcp_token`, read back from the fn's plain args. The contract declares them from this same
 * shape (`ginOf`); gin can't carry the zod type through, so they are parsed here once more.
 */
const MintArgs = z.object({ mcp: HubMcpId, label: z.string().min(1), ttl: z.number().int().min(1_000).optional() });

/** Register the mcp module's hub fns. Services are read when a fn runs. */
export function registerMcpFns(fns: HubFns, deps: { readonly tokens: () => Pick<McpTokens, 'mint'>; readonly settings: Pick<McpEnv, 'HARNESS_HUB_MCP_TOKEN_TTL'> }): void {
  fns.register(hub.fns.mint_mcp_token, async (raw, ctx) => {
    const args = MintArgs.parse(raw);
    const from = ctx.request.run.system.from?.system;
    const system = from === undefined ? undefined : SystemName.safeParse(from);
    if (system?.success !== true) throw new Error('only a system\'s fn may mint an MCP token, for a session it starts');
    const minted = await deps.tokens().mint({ mcp: args.mcp, label: args.label, ttl: args.ttl ?? deps.settings.HARNESS_HUB_MCP_TOKEN_TTL, system: system.data });
    return { token: minted.token, expiresAt: new Date(minted.expiresAt) };
  });
}
