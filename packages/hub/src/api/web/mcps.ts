/**
 * The hub MCPs slice (admins): make, change, preview, rotate and remove MCP endpoints, and see their open sessions,
 * through `hub.mcp` (`mcp/index.ts`). Writes run the admin operations, the same ones the hub's admin fns run in chat;
 * `createMcp` and `rotateMcpSecret` answer with the secret, the only time it is shown.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { mcpsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { AdminOperations } from '../admin-ops.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The mcps plugin. Requires the systems plugin, which binds `adminOnly`. */
export function mcpsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>, ops: AdminOperations) {
  const { registry, endpoints } = hub.mcp;
  return plugin({ name: 'web.mcps', spec: mcpsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof mcpsSlice> => ({
      mcps: () => registry.list(),
      mcp: async ({ data }) => {
        const found = await registry.get(data.mcp);
        if (found === undefined) { throw reject(404, 'MCP_NOT_FOUND', 'no such hub MCP'); }
        return found;
      },
      createMcp: ({ data, user }) => ops.create_mcp(data, user.id),
      updateMcp: ({ data, user }) => ops.update_mcp(data, user.id),
      rotateMcpSecret: ({ data, user }) => ops.rotate_mcp_secret(data, user.id),
      deleteMcp: ({ data, user }) => ops.delete_mcp(data, user.id),
      previewMcp: ({ data, user }) => ops.preview_mcp(data, user.id),
      mcpSessions: ({ data }) => endpoints.sessions(data.mcp),
    }));
}
