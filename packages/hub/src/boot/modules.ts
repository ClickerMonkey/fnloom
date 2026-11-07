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
import { executionModule, type LlmSource } from '../execution/create.ts';
import { buildSystems, type HubSystems } from '../link/build.ts';
import { linkServicesPlugin, serviceCatalog } from '../link/services.ts';
import { NodeInstaller, NodeLauncher, type Installer, type ProcessLauncher } from '../link/process.ts';
import { openSqliteStore } from '../store/sqlite.ts';
import { adminOperations, type AdminOperations } from '../api/admin-ops.ts';
import { registerAdminFns } from './admin-fns.ts';
import { registerHubFns } from './hub-fns.ts';
import { HUB_INFO } from './info.ts';
import type { HubModules, HubServices, ModuleContext, ModuleFactory } from './index.ts';

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
      settings: { hub: hub.settings.hubEnv, link: hub.settings.linkEnv, model: hub.settings.modelEnv, index: hub.settings.indexEnv, search: hub.settings.storeEnv },
      launcher: seams.launcher ?? new NodeLauncher({ baseEnv: process.env, nodeArgs: process.execArgv }),
      installer: seams.installer ?? new NodeInstaller(),
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
      const { connections, pairing, config, supervisor, admin, resources, output } = systems;
      return {
        services: { connections, pairing, config, supervisor, admin, resources, output, tokens: context.systemTokens },
        hooks: { links: { up: () => { systems.start(); return Promise.resolve(); }, pre: () => systems.stop() } },
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

/** The hub's production modules. */
export function hubModules(seams: ModuleSeams = {}): HubModules {
  return {
    store: openSqliteStore,
    ...systemsModules(seams),
    execution: executionModule({
      ...(seams.llm === undefined ? {} : { llm: seams.llm }),
      hubFns: (module, hub) => {
        registerHubFns(module.hubFns, {
          store: () => hub.store, catalog: () => hub.catalog, search: () => hub.index.search, sessions: () => hub.chat.sessions, handlers: () => module.handlers,
        });
        let ops: AdminOperations | undefined;
        registerAdminFns(module.hubFns, () => (ops ??= adminOperations(hub)));
      },
    }),
    chat: chatModule,
  };
}
