/**
 * The mcp module's factory: the registry over the hub store, scopes over the catalog and the resource router, session
 * tokens, and the endpoints that serve each enabled MCP at `/mcp/<slug>` (mounted as the hub starts its work, and
 * kept current as MCPs and the catalog change). Other modules are read when a method runs, never while building.
 */
import { limiter } from '@ayepi/rate';
import type { ModuleFactory } from '../boot/index.ts';
import { HUB_INFO } from '../boot/info.ts';
import { McpRunner } from './calls.ts';
import { HubMcpEndpoints } from './endpoints.ts';
import { StoreMcpRegistry } from './registry.ts';
import { CatalogMcpScopes } from './scopes.ts';
import { HubMcpPrompts, HubMcpResources } from './sources.ts';
import { JwtMcpTokens } from './tokens.ts';
import { HubMcpTools } from './tools.ts';

/** How many MCPs the endpoints mount at most. */
const MAX_MCPS = 500;

/** Builds the mcp module. */
export const mcpModule: ModuleFactory<'mcp'> = ({ hub }) => {
  const settings = hub.settings.mcpEnv;
  const clock = (): number => hub.clock();
  const registry: StoreMcpRegistry = new StoreMcpRegistry({
    store: hub.store, bus: hub.bus, clock, log: hub.log, publicUrl: hub.settings.packagingEnv.HARNESS_PUBLIC_URL ?? hub.settings.hubEnv.HARNESS_URL,
    // the endpoints are made below; this is only called once the hub is serving
    sessions: (mcp): number => endpoints.sessionCount(mcp),
  });
  const scopes = new CatalogMcpScopes({ catalog: () => hub.catalog, resources: () => hub.link.resources, registry: () => registry, bus: hub.bus });
  const tokens = new JwtMcpTokens({ keys: () => hub.store.ports.work.store, registry: () => registry, clock, log: hub.log, maxTtl: settings.HARNESS_HUB_MCP_TOKEN_TTL });
  const runner = new McpRunner({
    store: hub.store, runs: () => hub.execution.runs, limits: () => hub.execution.limits, clock, log: hub.log, settings,
    rate: limiter({ limit: settings.HARNESS_HUB_MCP_RATE, window: 60_000, algorithm: 'sliding-window', prefix: 'mcp:', store: hub.store.ports.rate }),
  });
  const sources = { scopes: () => scopes, catalog: () => hub.catalog, resources: () => hub.link.resources, content: () => hub.api.content };
  const endpoints: HubMcpEndpoints = new HubMcpEndpoints({
    registry: () => registry, tokens: () => tokens, bus: hub.bus, clock, log: hub.log, maxBody: settings.HARNESS_HUB_MCP_MAX_BODY, idleTimeout: settings.HARNESS_HUB_MCP_IDLE_TIMEOUT,
    serverInfo: { name: HUB_INFO.name, version: HUB_INFO.version },
    list: async () => (await hub.store.table('mcps').find({ where: { enabled: true }, limit: MAX_MCPS })).items,
    parts: (mcp) => ({
      tools: new HubMcpTools(mcp, { registry: () => registry, scopes: () => scopes, catalog: () => hub.catalog, runner, log: hub.log, access: () => hub.access }),
      resources: new HubMcpResources(mcp.id, sources),
      prompts: new HubMcpPrompts(mcp.id, sources),
    }),
  });
  let stop: (() => void) | undefined;
  return {
    services: { registry, scopes, endpoints, tokens },
    hooks: { work: { up: async () => { stop = await endpoints.start(); }, pre: () => { stop?.(); stop = undefined; return Promise.resolve(); } } },
  };
};
