/**
 * The admin area's root store: one of each admin store, sharing the actor directory, built from the admin callers,
 * the chat's inspection callers (runs, LLM calls and resources open with them) and the live channels. `start` follows
 * the user channel while an admin page is open.
 */
import { AutoPairStore } from './auto-pair.ts';
import { SuggestionsStore } from './suggestions.ts';
import type { UserEvents } from '../../api/notifications.ts';
import type { ChatApi, FileSender } from '../../chat/api.ts';
import type { McpProbe } from '../probe.ts';
import type { AdminApi, SystemLogEvents } from '../api.ts';
import { ActorsDirectory } from './actors.ts';
import type { FnRecord, ListQuery } from '@harness/core';
import { Paged } from '../../state/loaded.ts';
import { BROWSER_PAGE, llmBrowser, modelCallsBrowser, resourcesBrowser, runsBrowser, type LlmBrowser, type ModelCallsBrowser, type ResourcesBrowser, type RunsBrowser } from './browsers.ts';
import { FnStore } from './fn.ts';
import { InstanceStore } from './instance.ts';
import { McpStore, McpsStore } from './mcps.ts';
import { PackagesStore } from './packages.ts';
import { PairingPageStore } from './pairing.ts';
import { LimitsStore } from './limits.ts';
import { ModelsStore } from './models.ts';
import { PoliciesStore } from './policies.ts';
import { ModelRolesStore } from './roles.ts';
import { ActorSettingsStore } from './settings.ts';
import { SystemStore } from './system.ts';
import { SystemsStore } from './systems.ts';

/** What the admin stores are built from. */
export interface AdminDeps {
  readonly api: AdminApi;
  readonly chat: Pick<ChatApi, 'run' | 'llmCall' | 'resource' | 'background' | 'undoTurn'>;
  readonly userEvents: UserEvents;
  readonly systemLogs: SystemLogEvents;
  /** Sends package zips and data exports to the hub's presigned upload. */
  readonly sender: FileSender;
  /** Tries a hub MCP from the browser (its tools, with its secret). */
  readonly probe: McpProbe;
}

/** Every admin store. */
export class AdminStore {
  readonly actors: ActorsDirectory;
  readonly systems: SystemsStore;
  readonly system: SystemStore;
  readonly models: ModelsStore;
  readonly roles: ModelRolesStore;
  readonly limits: LimitsStore;
  readonly policies: PoliciesStore;
  readonly settings: ActorSettingsStore;
  readonly runs: RunsBrowser;
  readonly llm: LlmBrowser;
  readonly modelCalls: ModelCallsBrowser;
  readonly fn: FnStore;
  readonly instance: InstanceStore;
  readonly packages: PackagesStore;
  readonly mcps: McpsStore;
  readonly mcp: McpStore;
  readonly pairing: PairingPageStore;
  readonly resources: ResourcesBrowser;
  /** Every fn of every system with its stats, for the fns catalogue. */
  readonly fns: Paged<FnRecord, ListQuery>;
  /** The decision model for suggestions. */
  readonly suggestions: SuggestionsStore;
  /** A system's auto pair secrets. */
  readonly autoPairs: AutoPairStore;

  constructor(deps: AdminDeps) {
    const { api } = deps;
    this.actors = new ActorsDirectory(api);
    this.systems = new SystemsStore(api, deps.userEvents);
    this.system = new SystemStore(api, deps.userEvents, deps.systemLogs);
    this.models = new ModelsStore(api);
    this.roles = new ModelRolesStore(api);
    this.limits = new LimitsStore(api);
    this.policies = new PoliciesStore(api);
    this.settings = new ActorSettingsStore(api);
    this.runs = runsBrowser(api, deps.chat);
    this.llm = llmBrowser(api, deps.chat);
    this.modelCalls = modelCallsBrowser(api, deps.chat);
    this.fn = new FnStore(api, deps.userEvents);
    this.instance = new InstanceStore(api, deps.userEvents);
    this.packages = new PackagesStore(api, deps.sender);
    this.mcps = new McpsStore(api);
    this.mcp = new McpStore(api, deps.probe);
    this.pairing = new PairingPageStore(api, deps.userEvents);
    this.resources = resourcesBrowser(api, deps.chat);
    this.suggestions = new SuggestionsStore(api);
    this.autoPairs = new AutoPairStore(api);
    this.fns = new Paged({
      fetch: (query, cursor, limit) => api.fns.call({ ...query, limit, ...(cursor === undefined ? {} : { cursor }) }),
      key: (fn) => fn.name,
      failure: "Couldn't load the fns.",
      limit: BROWSER_PAGE,
    }, {});
  }

  /** Follow live changes and fetch what the nav counts. */
  start(): void {
    this.systems.start();
    if (this.systems.pairings.value.value === undefined) { void this.systems.load(true); }
  }

  stop(): void {
    this.systems.stop();
    this.system.close();
  }
}
