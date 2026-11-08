/**
 * The mcp module's factory. Until the hub-platform lane builds it, every service answers `NOT_BUILT`.
 */
import { notBuiltService } from '../boot/not-built.ts';
import type { ModuleFactory } from '../boot/index.ts';
import type { McpEndpoints, McpRegistry, McpScopes, McpTokens } from './index.ts';

/** Builds the mcp module. */
export const mcpModule: ModuleFactory<'mcp'> = () => ({
  services: {
    registry: notBuiltService<McpRegistry>('mcp.registry'),
    scopes: notBuiltService<McpScopes>('mcp.scopes'),
    endpoints: notBuiltService<McpEndpoints>('mcp.endpoints'),
    tokens: notBuiltService<McpTokens>('mcp.tokens'),
  },
});
