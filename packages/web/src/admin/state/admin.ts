/**
 * The admin area's root store: one of each admin store, sharing the actor directory, built from the admin callers,
 * the chat's inspection callers (runs, LLM calls and resources open with them) and the live channels. `start` follows
 * the user channel while an admin page is open.
 */
import { AutoPairStore } from './auto-pair.ts';
import { SuggestionsStore } from './suggestions.ts';
import { ClassifierStore } from './classifier.ts';
import type { UserEvents } from '../../api/notifications.ts';
import type { ChatApi, FileSender } from '../../chat/api.ts';
import type { McpProbe } from '../probe.ts';
import type { AdminApi, SystemLogEvents } from '../api.ts';
import type { DataApi } from '../../data/api.ts';
import { ActorsDirectory } from './actors.ts';
import { ApprovalDesk } from '../../chat/state/approvals.ts';
import type { FnRecord, ListQuery } from '@harness/core';
import { Paged } from '../../state/loaded.ts';
import { BROWSER_PAGE, llmBrowser, modelCallsBrowser, resourcesBrowser, runsBrowser, type LlmBrowser, type ModelCallsBrowser, type ResourcesBrowser, type RunsBrowser } from './browsers.ts';
import { FnStore } from './fn.ts';
import { InstanceStore } from './instance.ts';
import { InstancePartsStore } from './instance-parts.ts';
import { McpStore, McpsStore } from './mcps.ts';
import { McpServersStore } from './mcp-servers.ts';
import { ApiServicesStore } from './api-services.ts';
import { PackagesStore } from './packages.ts';
import { PairingPageStore } from './pairing.ts';
import { LimitsStore } from './limits.ts';
import { ModelsStore } from './models.ts';
import { PoliciesStore } from './policies.ts';
import { ModelRolesStore } from './roles.ts';
import { ActorSettingsStore } from './settings.ts';
import { ReviewStore } from './review.ts';
import { SystemStore } from './system.ts';
import { SystemPartsStore } from './system-parts.ts';
import { SystemsStore } from './systems.ts';

/** What the admin stores are built from. */
export interface AdminDeps {
  readonly api: AdminApi;
  readonly chat: Pick<ChatApi, 'run' | 'llmCall' | 'resource' | 'background' | 'undoTurn' | 'types' | 'approvals' | 'approve'>;
  readonly userEvents: UserEvents;
  readonly systemLogs: SystemLogEvents;
  /** Sends package zips and data exports to the hub's presigned upload. */
  readonly sender: FileSender;
  /** Tries a hub MCP from the browser (its tools, with its secret). */
  readonly probe: McpProbe;
  /** The data system's record callers: the API services are records of the api system. */
  readonly data: Pick<DataApi, 'records' | 'saveRecord' | 'removeRecord'>;
}

/** Every admin store. */
export class AdminStore {
  readonly actors: ActorsDirectory;
  readonly systems: SystemsStore;
  readonly system: SystemStore;
  /** The open system's context and types. */
  readonly systemParts: SystemPartsStore;
  /** The open system's review: its stage, what it declares, what is off, what waits, and its refusals (build 7). */
  readonly review: ReviewStore;
  readonly models: ModelsStore;
  readonly roles: ModelRolesStore;
  readonly limits: LimitsStore;
  readonly policies: PoliciesStore;
  readonly settings: ActorSettingsStore;
  readonly runs: RunsBrowser;
  /** The approvals of runs opened in the runs browser, answered from the run's panel. */
  readonly runApprovals: ApprovalDesk;
  readonly llm: LlmBrowser;
  readonly modelCalls: ModelCallsBrowser;
  readonly fn: FnStore;
  readonly instance: InstanceStore;
  /** What an instance owns: its fns, types and the changes its system proposed. */
  readonly instanceParts: InstancePartsStore;
  readonly packages: PackagesStore;
  readonly mcps: McpsStore;
  readonly mcp: McpStore;
  /** Build 9: MCP servers the hub connects to, each an instance of the `mcp` system. */
  readonly mcpServers: McpServersStore;
  /** Build 9: API services api fns run on, each an instance of the `api` system. */
  readonly apiServices: ApiServicesStore;
  readonly pairing: PairingPageStore;
  readonly resources: ResourcesBrowser;
  /** Every fn of every system with its stats, for the fns catalogue. */
  readonly fns: Paged<FnRecord, ListQuery>;
  /** The decision model for suggestions. */
  readonly suggestions: SuggestionsStore;
  /** The model a chat in auto mode asks about calls that write or delete. */
  readonly classifier: ClassifierStore;
  /** A system's auto pair secrets. */
  readonly autoPairs: AutoPairStore;

  constructor(deps: AdminDeps) {
    const { api } = deps;
    this.actors = new ActorsDirectory(api);
    this.systems = new SystemsStore(api, deps.userEvents);
    this.system = new SystemStore(api, deps.userEvents, deps.systemLogs);
    this.systemParts = new SystemPartsStore(api);
    this.review = new ReviewStore(api);
    this.models = new ModelsStore(api);
    this.roles = new ModelRolesStore(api);
    this.limits = new LimitsStore(api);
    this.policies = new PoliciesStore(api);
    this.settings = new ActorSettingsStore(api);
    this.runs = runsBrowser(api, deps.chat);
    this.runApprovals = new ApprovalDesk(deps.chat);
    this.llm = llmBrowser(api, deps.chat);
    this.modelCalls = modelCallsBrowser(api, deps.chat);
    this.fn = new FnStore(api, deps.userEvents);
    this.instance = new InstanceStore(api, deps.userEvents);
    this.instanceParts = new InstancePartsStore(api, deps.chat);
    this.packages = new PackagesStore(api, deps.sender);
    this.mcps = new McpsStore(api);
    this.mcp = new McpStore(api, deps.probe);
    this.mcpServers = new McpServersStore(api);
    this.apiServices = new ApiServicesStore({ fns: api.fns, records: deps.data.records, saveRecord: deps.data.saveRecord, removeRecord: deps.data.removeRecord });
    this.pairing = new PairingPageStore(api, deps.userEvents);
    this.resources = resourcesBrowser(api, deps.chat);
    this.suggestions = new SuggestionsStore(api);
    this.classifier = new ClassifierStore(api);
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
