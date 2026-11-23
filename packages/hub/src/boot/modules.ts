/**
 * The one place the hub's modules are chosen: how the store opens, and the factory that builds each module from
 * `ModuleContext`. A factory returns its services, the lifecycle hooks it needs (`work`: start and stop queues;
 * `links`; `installed`) and the ayepi plugins it serves on the system link. Factories read other modules lazily
 * (inside their methods), so the order modules are written here doesn't matter.
 *
 * The catalog, link and index modules are one build (`buildSystems`): each of their factories returns its part of it.
 */
import type { Logger } from '@ayepi/log';
import { hubLinkSpec, instanceLabel, type ActorId } from '@harness/core';
import { reject, spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { hub, manifestOf } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import { createChat } from '../chat/chat.ts';
import { resourceFiles } from '../chat/files.ts';
import { executionModule, type ExecutionModule, type LlmSource } from '../execution/create.ts';
import { runIsOf } from '../execution/link-handlers.ts';
import { buildSystems, type HubSystems } from '../link/build.ts';
import { linkServicesPlugin, serviceCatalog } from '../link/services.ts';
import { linkReadsPlugin } from '../link/reads.ts';
import { ownerRunsPlugin } from '../link/owner-runs.ts';
import { adminReadOperations, exploreOperations, personOperations, type AdminReadOperations, type ExploreOperations, type PersonOperations } from '../api/person-ops.ts';
import { registerPersonFns } from './person-fns.ts';
import { NodeStarter, type ProcessStarter } from '@harness/sdk/server';
import type { Installer } from '../link/process.ts';
import { openSqliteStore } from '../store/sqlite.ts';
import { adminOperations, type AdminOperations } from '../api/admin-ops.ts';
import { hubReads, type HubReads } from '../api/reads.ts';
import { registerMcpFns } from '../mcp/fns.ts';
import type { McpScope } from '../mcp/index.ts';
import { registerAdminFns } from './admin-fns.ts';
import { AdminArgSecrets } from './admin-secrets.ts';
import { registerReadFns } from './read-fns.ts';
import { registerHubFns } from './hub-fns.ts';
import { HUB_INFO } from './info.ts';
import { migrateOldVersions } from '../catalog/versions.ts';
import { withHubGroups } from './hub-groups.ts';
import { withHubContext } from './hub-context.ts';
import { mentionSearchPlugin } from '../chat/mention-search.ts';
import type { HubModules, HubServices, ModuleContext, ModuleFactory } from './index.ts';
import { contextorModule } from '../contextor/create.ts';
import { registerContextorFns } from '../contextor/fns.ts';
import { mcpModule } from '../mcp/create.ts';
import { metricsModule } from '../metrics/create.ts';
import { modelsModule } from '../models/create.ts';
import { resourcesModule } from '../resources/create.ts';
import { registerResourceFns } from '../resources/fns.ts';
import { accessModule } from '../access/create.ts';
import { dataModule } from '../data/create.ts';
import { registerDataFns } from '../data/fns.ts';
import { registerTableFns, tableServiceOf } from '../tables/fns.ts';
import type { TableService } from '../tables/index.ts';
import { migrateWidgets } from '../tables/migrate.ts';
import { migrateFnNames } from '../store/migrate-fn-names.ts';
import { connectionsModule } from '../connections/create.ts';
import { fnsModule } from '../fns/create.ts';

/** What the production modules can be given instead of their defaults (tests, the e2e hub). */
export interface ModuleSeams {
  /** How systems the hub installs are started (default: Node child processes with this process's env and Node flags). */
  readonly launcher?: ProcessStarter;
  /** How systems are installed from a folder, npm or git (default: npm and git on this machine). */
  readonly installer?: Installer;
  /** Where models come from (default: OpenRouter with `OPENROUTER_API_KEY`). */
  readonly llm?: (hub: HubServices) => LlmSource;
}

/** Import the hub's own contract, so its agent and fns resolve like any system's. Refused entries fail the start. */
async function importHubContract(catalog: Catalog, log: Logger): Promise<void> {
  // its fns in their API groups, so the catalog writes the hub's API index like any system's; its context files
  // (packages/hub/context/: the hub's features, injected into the chat agents) join its context
  const report = await catalog.importManifest(withHubGroups(await withHubContext(await manifestOf(hub, { version: HUB_INFO.version }))));
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
        search: hub.settings.storeEnv, review: hub.settings.reviewEnv,
      },
      launcher: seams.launcher ?? new NodeStarter({ baseEnv: process.env, nodeArgs: process.execArgv, outputTail: hub.settings.linkEnv.HARNESS_PROCESS_OUTPUT_TAIL }),
      ...(seams.installer === undefined ? {} : { installer: seams.installer }),
      content: () => hub.api.content,
      secrets: () => hub.api.secrets,
      // the index embeds through the hub's AI, so its calls are priced and recorded with every other embed
      ai: () => hub.execution.llm,
      // plan item 7: fns that need a model role (`hub/ctx_crawl` needs `decide`) are off while it has no model
      roleSet: (role) => hub.models.roles.isSet(role),
    });
    builds.set(context, built);
    return built;
  };
  return {
    catalog: (context) => {
      const { catalog } = systemsOf(context);
      // the hub's own contract (its chat agent, its fns, mentions and types) is in the catalog like any system's
      // build 5's fn versions and build 7's type versions move into the one history table before anything imports, and
      // build 8's hub widgets become the widgets system's
      const up = async (): Promise<void> => {
        await migrateOldVersions(context.hub.store, context.hub.log);
        await migrateWidgets(context.hub.store, context.hub.log);
        // the one fn name: stored tool calls and renamed fns, before anything reads them
        await migrateFnNames(context.hub.store, context.hub.log);
        await catalog.indexStoredFns();
        await importHubContract(catalog, context.hub.log);
        // a role set or cleared turns the fns that need it on or off
        context.hub.bus.subscribe('model.role.changed', ({ role }) => {
          catalog.refreshRoles([role]).catch((error: unknown) => { context.hub.log.error('catalog.roles.refresh.failed', { role }, error); });
        });
      };
      return { services: catalog, hooks: { work: { up } } };
    },
    link: (context) => {
      const { hub } = context;
      const systems = systemsOf(context);
      const { connections, pairing, config, supervisor, admin, resources, output, packages, router, autoPairs, lifecycle, grants, gate } = systems;
      return {
        services: { connections, pairing, config, supervisor, admin, resources, output, packages, instances: router, autoPairs, tokens: context.systemTokens, lifecycle, grants, gate },
        hooks: {
          // build 1's single-instance rows move onto instances before any system can connect
          work: { up: async () => { await systems.migrate(); } },
          links: { up: () => { systems.start(); return Promise.resolve(); }, pre: () => systems.stop() },
        },
        linkPlugins: [systems.plugin, linkServicesPlugin({
          store: () => hub.store, catalog: () => serviceCatalog(hub.catalog), content: () => hub.api.content, state: () => hub.chat.state, turns: () => hub.chat.turns,
          maxUpload: hub.settings.httpEnv.HARNESS_MAX_UPLOAD, uploadTtl: hub.settings.httpEnv.HARNESS_PRESIGN_TTL,
          maxUploads: hub.settings.linkEnv.HARNESS_LINK_MAX_UPLOADS, clock: hub.clock,
          access: (actor) => hub.access.scope(actor), bus: () => hub.bus,
        }), ownerRunsPlugin({
          // a system's runs of its own kinds' fns, started as their owners, and its notices to people (`runs` grant)
          store: () => hub.store, catalog: () => hub.catalog, runs: () => hub.execution.runs, limits: () => hub.execution.limits,
          notifications: () => hub.chat.notifications, sharing: () => hub.access, bus: () => hub.bus, clock: hub.clock, log: hub.log,
        }), linkReadsPlugin({
          store: () => hub.store, access: (actor) => hub.access.scope(actor), router: () => hub.link.resources, reader: () => hub.resources.reader, pairing: () => hub.link.pairing,
        })],
      };
    },
    index: (context) => {
      const { embedders, indexer, search, suggest, images } = systemsOf(context).index;
      return { services: { embedders, indexer, search, suggest, images } };
    },
  };
}

/** The slice of the hub link chat serves: a system's question to the decision model (`decide`). */
export const DECIDE_LINK_SPEC = spec({ endpoints: { decide: hubLinkSpec.endpoints.decide } });

/** The chat module over the other modules' services. */
const chatModule: ModuleFactory<'chat'> = ({ hub, hubActor }) => {
  const { settings } = hub;
  const chat = createChat({
    settings: { chat: settings.chatEnv, queue: settings.queueEnv, model: settings.modelEnv },
    log: hub.log, clock: hub.clock, bus: hub.bus, store: hub.store, catalog: hub.catalog, link: hub.link.connections,
    runs: hub.execution.runs, agents: hub.execution.agents, limits: hub.execution.limits,
    search: hub.index.search, suggest: hub.index.suggest, llm: hub.execution.llm, push: hub.api.push, hubActor, access: { scope: (actor) => hub.access.scope(actor) },
    // the models module is read when a decision is made, never while chat is built
    decider: { model: (choice) => hub.models.decider.model(choice), ask: (request) => hub.models.decider.ask(request) },
    // a sent message's files become hub resources the model reads in one call (`chat/files.ts`)
    files: resourceFiles(() => hub.resources),
    // the contextor's flexible budget for the message, so context a chooser loads into it is sized to the room left
    promptRoom: async ({ session, text, actor }) => {
      const { budget } = await hub.contextor.planner.preview(session, text, actor);
      return budget.window - budget.output - budget.reasoning - budget.margin - budget.fixed;
    },
  });
  let stop: (() => void) | undefined;
  return {
    services: chat,
    hooks: { work: { up: () => { stop = chat.start(); return Promise.resolve(); }, pre: () => { stop?.(); return Promise.resolve(); } } },
    linkPlugins: [plugin({ name: 'decide', spec: DECIDE_LINK_SPEC }).handlers(() => ({
      decide: async ({ data, link }) => {
        // the call is charged to the run, so it must be one of the asking instance's
        const run = await hub.store.table('runs').get(data.run);
        if (run === undefined || !runIsOf(run, link)) { throw reject(403, 'NOT_YOUR_RUN', `run ${data.run} is not ${instanceLabel(link)}'s`); }
        return chat.suggestions.forSystem(data);
      },
    })), mentionSearchPlugin({
      requests: () => chat.mentionRequests, store: () => hub.store, search: () => hub.index.search, catalog: () => hub.catalog, access: (actor) => hub.access.scope(actor),
    })],
  };
};

/**
 * Implement the hub contract on execution's `HubFns`: the hub's own fns, the admin and read fns, and each module's
 * (mcp, resources, contextor). Every native fn the contract declares is implemented here (a boot test checks it);
 * services are read when a fn runs, never while registering.
 */
export function registerHubContract(
  module: { readonly hubFns: ExecutionModule['hubFns']; readonly handlers: Pick<ExecutionModule['handlers'], 'askPerson'>; readonly runs?: Pick<ExecutionModule['runs'], 'sealArgsWith'> },
  hub: HubServices,
): void {
  // what the hub MCP a run's caller acts as exposes, so fns that reach resources and context keep to its rules
  const mcpScope = async (caller: ActorId): Promise<McpScope | undefined> => {
    const mcp = (await hub.store.table('mcps').find({ where: { actor: caller }, limit: 1 })).items[0];
    return mcp === undefined ? undefined : hub.mcp.scopes.scope(mcp.id);
  };
  registerHubFns(module.hubFns, {
    store: () => hub.store, catalog: () => hub.catalog, search: () => hub.index.search, sessions: () => hub.chat.sessions, handlers: () => module.handlers,
    access: (actor) => hub.access.scope(actor), sharing: () => hub.access, fns: () => hub.fns, facts: () => hub.fns.facts, views: () => hub.contextor.views, mcpScope, decider: () => hub.models.decider, searchLoadMax: hub.settings.fnsEnv.HARNESS_SEARCH_LOAD_MAX,
  });
  let ops: AdminOperations | undefined;
  registerAdminFns(module.hubFns, () => (ops ??= adminOperations(hub)));
  // the secrets the admin fns' args carry (a system's config, a provider's keys) are stored sealed on their runs
  module.runs?.sealArgsWith(new AdminArgSecrets(hub));
  let reads: HubReads | undefined;
  registerReadFns(module.hubFns, () => (reads ??= hubReads(hub)));
  let person: PersonOperations | undefined;
  let explore: ExploreOperations | undefined;
  let adminReads: AdminReadOperations | undefined;
  registerPersonFns(module.hubFns, {
    person: () => (person ??= personOperations(hub)), explore: () => (explore ??= exploreOperations(hub)), adminReads: () => (adminReads ??= adminReadOperations(hub)),
  });
  registerDataFns(module.hubFns, { data: () => hub.data, access: (actor) => hub.access.scope(actor) });
  let tables: TableService | undefined;
  registerTableFns(module.hubFns, () => (tables ??= tableServiceOf(hub)));
  registerMcpFns(module.hubFns, { tokens: () => hub.mcp.tokens, settings: hub.settings.mcpEnv });
  registerResourceFns(module.hubFns, { resources: () => hub.resources, store: () => hub.store, llm: () => hub.execution.llm, mcpScope, access: (actor) => hub.access.scope(actor) });
  registerContextorFns(module.hubFns, {
    store: () => hub.store, catalog: () => hub.catalog, search: () => hub.index.search, sessions: () => hub.chat.sessions,
    contextor: () => hub.contextor, views: () => hub.contextor.views, mcpScope, access: (actor) => hub.access.scope(actor),
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
    ...BUILD_4_MODULES,
    ...BUILD_5_MODULES,
    ...BUILD_8_MODULES,
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

/** Build 4's modules: visibility and per-person connections. */
export const BUILD_4_MODULES = {
  access: accessModule,
  connections: connectionsModule,
} as const satisfies Pick<HubModules, 'access' | 'connections'>;

/** Build 8's modules: the data system. */
export const BUILD_8_MODULES = {
  data: dataModule,
} as const satisfies Pick<HubModules, 'data'>;

/** Build 5's modules: fns search, examples, facts, the chat fn mode, browser logs. */
export const BUILD_5_MODULES = {
  fns: fnsModule,
} as const satisfies Pick<HubModules, 'fns'>;
