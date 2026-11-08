/**
 * The hub MCPs slice (hub-platform lane, admins): make, change, preview, rotate and remove MCP endpoints, and see
 * their open sessions, through `hub.mcp` (`mcp/index.ts`). The same operations are admin fns.
 */
import { plugin } from '@ayepi/plugin';
import { mcpsSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The mcps plugin. Requires the systems plugin, which binds `adminOnly`. */
export function mcpsPlugin(systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.mcps', spec: mcpsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof mcpsSlice> => ({
      mcps: notBuilt('Hub MCPs'),
      mcp: notBuilt('Hub MCPs'),
      createMcp: notBuilt('Making MCPs'),
      updateMcp: notBuilt('Changing MCPs'),
      rotateMcpSecret: notBuilt('Rotating MCP secrets'),
      deleteMcp: notBuilt('Removing MCPs'),
      previewMcp: notBuilt('MCP previews'),
      mcpSessions: notBuilt('MCP sessions'),
    }));
}
