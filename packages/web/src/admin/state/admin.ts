/**
 * The admin area's root store: one of each admin store, sharing the actor directory, built from the admin callers,
 * the chat's inspection callers (runs, LLM calls and resources open with them) and the live channels. `start` follows
 * the user channel while an admin page is open.
 */
import type { UserEvents } from '../../api/notifications.ts';
import type { ChatApi } from '../../chat/api.ts';
import type { AdminApi, SystemLogEvents } from '../api.ts';
import { ActorsDirectory } from './actors.ts';
import { llmBrowser, resourcesBrowser, runsBrowser, type LlmBrowser, type ResourcesBrowser, type RunsBrowser } from './browsers.ts';
import { LimitsStore } from './limits.ts';
import { ModelsStore } from './models.ts';
import { PoliciesStore } from './policies.ts';
import { ActorSettingsStore } from './settings.ts';
import { SystemStore } from './system.ts';
import { SystemsStore } from './systems.ts';

/** What the admin stores are built from. */
export interface AdminDeps {
  readonly api: AdminApi;
  readonly chat: Pick<ChatApi, 'run' | 'llmCall' | 'resource' | 'background' | 'undoTurn'>;
  readonly userEvents: UserEvents;
  readonly systemLogs: SystemLogEvents;
}

/** Every admin store. */
export class AdminStore {
  readonly actors: ActorsDirectory;
  readonly systems: SystemsStore;
  readonly system: SystemStore;
  readonly models: ModelsStore;
  readonly limits: LimitsStore;
  readonly policies: PoliciesStore;
  readonly settings: ActorSettingsStore;
  readonly runs: RunsBrowser;
  readonly llm: LlmBrowser;
  readonly resources: ResourcesBrowser;

  constructor(deps: AdminDeps) {
    const { api } = deps;
    this.actors = new ActorsDirectory(api);
    this.systems = new SystemsStore(api, deps.userEvents);
    this.system = new SystemStore(api, deps.userEvents, deps.systemLogs);
    this.models = new ModelsStore(api);
    this.limits = new LimitsStore(api);
    this.policies = new PoliciesStore(api);
    this.settings = new ActorSettingsStore(api);
    this.runs = runsBrowser(api, deps.chat);
    this.llm = llmBrowser(api, deps.chat);
    this.resources = resourcesBrowser(api, deps.chat);
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
