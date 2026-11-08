/**
 * The one place the hub's modules are chosen: how the store opens, and the factory that builds each module from
 * `ModuleContext`. A factory returns its services, the lifecycle hooks it needs (`work`: start and stop queues;
 * `links`; `installed`) and the ayepi plugins it serves on the system link. Factories read other modules lazily
 * (inside their methods), so the order modules are written here doesn't matter.
 *
 * The catalog, link and index modules are one build (`buildSystems`): each of their factories returns its part of it.
 */
import type { Logger } from '@ayepi/log';
import { hub, manifestOf } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import { createChat } from '../chat/chat.ts';
import { executionModule, type ExecutionModule, type LlmSource } from '../execution/create.ts';
import { buildSystems, type HubSystems } from '../link/build.ts';
import { linkServicesPlugin, serviceCatalog } from '../link/services.ts';
import { NodeLauncher, type Installer, type ProcessLauncher } from '../link/process.ts';
import { openSqliteStore } from '../store/sqlite.ts';
import { adminOperations, type AdminOperations } from '../api/admin-ops.ts';
import { hubReads, type HubReads } from '../api/reads.ts';
import { registerMcpFns } from '../mcp/fns.ts';
import { registerAdminFns } from './admin-fns.ts';
import { registerReadFns } from './read-fns.ts';
import { registerHubFns } from './hub-fns.ts';
import { HUB_INFO } from './info.ts';
import type { HubModules, HubServices, ModuleContext, ModuleFactory } from './index.ts';
import { contextorModule } from '../contextor/create.ts';
import { registerContextorFns } from '../contextor/fns.ts';
import { mcpModule } from '../mcp/create.ts';
import { metricsModule } from '../metrics/create.ts';
import { modelsModule } from '../models/create.ts';
import { resourcesModule } from '../resources/create.ts';
import { registerResourceFns } from '../resources/fns.ts';

/** What the production modules can be given instead of their defaults (tests, the e2e hub). */
export interface ModuleSeams {
  /** How systems the hub installs are started (default: Node child processes with this process's env and Node flags). */
  readonly launcher?: ProcessLauncher;
  /** How systems are installed from a folder, npm or git (default: npm and git on this machine). */
  readonly installer?: Installer;
  /** Where models come from (default: OpenRouter with `OPENROUTER_API_KEY`). */
  readonly llm?: (hub: HubServices) => LlmSource;
}

/** Import the hub's own contract, so its agent and fns resolve like any system's. Refused entries fail the start. */
async function importHubContract(catalog: Catalog, log: Logger): Promise<void> {
  const report = await catalog.importManifest(await manifestOf(hub, { version: HUB_INFO.version }));
  if (report.refused.length > 0) {
    throw new Error(`the hub's own contract was refused: ${report.refused.map((r) => `${r.name}: ${r.problems.join('; ')}`).join(' | ')}`);
  }
  log.info('catalog.hub.imported', { version: HUB_INFO.version });
}

/** The catalog, link and index factories over one shared `buildSystems`, built the first time any of them is asked for. */
function systemsModules(seams: ModuleSeams): Pick<HubModules, 'catalog' | 'link' | 'index'> {
  const builds = new WeakMap<ModuleContext, HubSystems>();
  const systemsOf = (context: ModuleContext): HubSystems => {
    const known = builds.get(context);
    if (known !== undefined) { return known; }
    const { hub } = context;
    const built = buildSystems({
      store: hub.store, bus: hub.bus, log: hub.log, clock: hub.clock, peers: context.peers, tokens: context.systemTokens,
      settings: {
        hub: hub.settings.hubEnv, link: hub.settings.linkEnv, packaging: hub.settings.packagingEnv, model: hub.settings.modelEnv, index: hub.settings.indexEnv,
        search: hub.settings.storeEnv,
      },
      launcher: seams.launcher ?? new NodeLauncher({ baseEnv: process.env, nodeArgs: process.execArgv }),
      ...(seams.installer === undefined ? {} : { installer: seams.installer }),
      content: () => hub.api.content,
      calls: () => hub.metrics.calls,
    });
    builds.set(context, built);
    return built;
  };
  return {
    catalog: (context) => {
      const { catalog } = systemsOf(context);
      // the hub's own contract (its chat agent, its fns, mentions and types) is in the catalog like any system's
      return { services: catalog, hooks: { work: { up: () => importHubContract(catalog, context.hub.log) } } };
    },
    link: (context) => {
      const { hub } = context;
      const systems = systemsOf(context);
      const { connections, pairing, config, supervisor, admin, resources, output, packages, router } = systems;
      return {
        services: { connections, pairing, config, supervisor, admin, resources, output, packages, instances: router, tokens: context.systemTokens },
        hooks: {
          // build 1's single-instance rows move onto instances before any system can connect
          work: { up: async () => { await systems.migrate(); } },
          links: { up: () => { systems.start(); return Promise.resolve(); }, pre: () => systems.stop() },
        },
        linkPlugins: [systems.plugin, linkServicesPlugin({
          store: () => hub.store, catalog: () => serviceCatalog(hub.catalog), content: () => hub.api.content, state: () => hub.chat.state, turns: () => hub.chat.turns,
          maxUpload: hub.settings.httpEnv.HARNESS_MAX_UPLOAD, uploadTtl: hub.settings.httpEnv.HARNESS_PRESIGN_TTL, clock: hub.clock,
        })],
      };
    },
    index: (context) => {
      const { embedders, indexer, search, suggest } = systemsOf(context).index;
      return { services: { embedders, indexer, search, suggest } };
    },
  };
}

/** The chat module over the other modules' services. */
const chatModule: ModuleFactory<'chat'> = ({ hub, hubActor }) => {
  const { settings } = hub;
  const chat = createChat({
    settings: { chat: settings.chatEnv, queue: settings.queueEnv, model: settings.modelEnv },
    log: hub.log, clock: hub.clock, bus: hub.bus, store: hub.store, catalog: hub.catalog, link: hub.link.connections,
    runs: hub.execution.runs, agents: hub.execution.agents, limits: hub.execution.limits,
    search: hub.index.search, suggest: hub.index.suggest, push: hub.api.push, hubActor,
  });
  let stop: (() => void) | undefined;
  return {
    services: chat,
    hooks: { work: { up: () => { stop = chat.start(); return Promise.resolve(); }, pre: () => { stop?.(); return Promise.resolve(); } } },
  };
};

/**
 * Implement the hub contract on execution's `HubFns`: the hub's own fns, the admin and read fns, and each module's
 * (mcp, resources, contextor). Every native fn the contract declares is implemented here (a boot test checks it);
 * services are read when a fn runs, never while registering.
 */
export function registerHubContract(module: { readonly hubFns: ExecutionModule['hubFns']; readonly handlers: Pick<ExecutionModule['handlers'], 'askPerson'> }, hub: HubServices): void {
  registerHubFns(module.hubFns, {
    store: () => hub.store, catalog: () => hub.catalog, search: () => hub.index.search, sessions: () => hub.chat.sessions, handlers: () => module.handlers,
  });
  let ops: AdminOperations | undefined;
  registerAdminFns(module.hubFns, () => (ops ??= adminOperations(hub)));
  let reads: HubReads | undefined;
  registerReadFns(module.hubFns, () => (reads ??= hubReads(hub)));
  registerMcpFns(module.hubFns, { tokens: () => hub.mcp.tokens, settings: hub.settings.mcpEnv });
  registerResourceFns(module.hubFns, { resources: () => hub.resources, store: () => hub.store, llm: () => hub.execution.llm });
  registerContextorFns(module.hubFns, {
    store: () => hub.store, catalog: () => hub.catalog, search: () => hub.index.search, sessions: () => hub.chat.sessions,
    contextor: () => hub.contextor, views: () => hub.contextor.views,
    mcpScope: async (caller) => {
      const mcp = (await hub.store.table('mcps').find({ where: { actor: caller }, limit: 1 })).items[0];
      return mcp === undefined ? undefined : hub.mcp.scopes.scope(mcp.id);
    },
  });
}

/** The hub's production modules. */
export function hubModules(seams: ModuleSeams = {}): HubModules {
  return {
    store: openSqliteStore,
    ...systemsModules(seams),
    execution: executionModule({
      ...(seams.llm === undefined ? {} : { llm: seams.llm }),
      hubFns: registerHubContract,
    }),
    chat: chatModule,
    ...BUILD_2_MODULES,
  };
}

/** Build 2's modules, each its lane's factory (`<module>/create.ts`). */
export const BUILD_2_MODULES = {
  contextor: contextorModule,
  resources: resourcesModule,
  mcp: mcpModule,
  metrics: metricsModule,
  models: modelsModule,
} as const satisfies Pick<HubModules, 'contextor' | 'resources' | 'mcp' | 'metrics' | 'models'>;
