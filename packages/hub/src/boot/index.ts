/**
 * The boot module: the hub process. It parses the env slices, makes the logger (`@ayepi/log`, structured keys,
 * secrets redacted, console intercepted), opens the store, builds every module's services from its `ModuleFactory`,
 * installs the ayepi plugins (web API and system link), and starts and stops it all in dependency order with
 * `@ayepi/updown`.
 *
 * Owner: the api lane (with api). `startHub` is in `boot/start.ts`, the process entry in `main.ts`.
 */
import type { Peers } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import type { AnyPlugin } from '@ayepi/plugin';
import type { ActorId, HandlerCallId, Json, SystemLinkSpec } from '@harness/core';
import type { Authenticator, ContentStore, EventRelay, PushService, SecretVault } from '../api/index.ts';
import type { HubIdentityService } from './identity.ts';
import type { HubHttps } from '../api/https.ts';
import type { SsoService } from '../api/sso.ts';
import type { DataService } from '../data/index.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import type {
  ApproverDirectory, CompareService, DeliveryService, MentionService, MessageEnricher, NotificationService, PresenceTracker, ReplyRule, SessionService, StateService, SuggestionDecider, TurnService, UndoService,
} from '../chat/index.ts';
import type { AgentLoop, Ledger, LimitResolver, LlmGateway, PolicyEngine, ProviderService, RunService } from '../execution/index.ts';
import type { Embedders, Indexer, Search, Suggester } from '../index/index.ts';
import type { ImageEmbeddingSettings } from '../index/image-setting.ts';
import type {
  ConfigService, InstanceRouter, LinkService, Packages, PairingService, ResourceRouter, Supervisor, SystemAdmin, SystemOutput, SystemTokens,
} from '../link/index.ts';
import type { AutoPairService } from '../link/auto-pair.ts';
import type { SystemGrantGuard } from '../link/grants.ts';
import type { LinkGate } from '../link/gate.ts';
import type { SystemLifecycle } from '../link/lifecycle.ts';
import type { HubStore, StoreFactory } from '../store/index.ts';
import type { AccessService } from '../access/index.ts';
import type { ConnectionService } from '../connections/index.ts';
import type { FnsServices } from '../fns/index.ts';
import type { ContextorServices } from '../contextor/index.ts';
import type { McpServices } from '../mcp/index.ts';
import type { MetricsServices } from '../metrics/index.ts';
import type { ModelServices } from '../models/index.ts';
import type { ResourceServices } from '../resources/index.ts';
import type { HubSettings } from './env.ts';

/** A person's answer to a handler a run asked them for (`answer` in the web API). Implemented by the execution module. */
export interface HandlerAnswers {
  /** Give the waiting run its value. Refused unless `by` is the person the call asked. */
  answer(call: HandlerCallId, value: Json, by: ActorId): Promise<void>;
}

/**
 * Every hub service, by module. Modules depend on each other only through this (and the bus), never on each other's
 * implementation files, so each lane can build and test its module alone with fakes for the rest.
 */
export interface HubServices {
  readonly settings: HubSettings;
  readonly log: Logger;
  readonly clock: () => number;
  readonly bus: EventBus;
  readonly store: HubStore;
  readonly catalog: Catalog;
  readonly link: {
    readonly connections: LinkService; readonly pairing: PairingService; readonly config: ConfigService; readonly supervisor: Supervisor;
    readonly admin: SystemAdmin; readonly resources: ResourceRouter; readonly tokens: SystemTokens; readonly output: SystemOutput;
    readonly packages: Packages; readonly instances: InstanceRouter; readonly autoPairs: AutoPairService;
    /** Build 7: installed vs live, reviews and per-item switches. */
    readonly lifecycle: SystemLifecycle;
    /** Build 7: what systems may do through the hub, and the refusals. */
    readonly grants: SystemGrantGuard;
    /** How many `/link` sockets that haven't finished the handshake are kept, and for how long. */
    readonly gate: LinkGate;
  };
  readonly execution: {
    readonly runs: RunService; readonly agents: AgentLoop; readonly llm: LlmGateway; readonly limits: LimitResolver; readonly ledger: Ledger;
    readonly policies: PolicyEngine; readonly handlers: HandlerAnswers; readonly providers: ProviderService;
  };
  readonly chat: {
    readonly sessions: SessionService; readonly turns: TurnService; readonly reply: ReplyRule; readonly enrich: MessageEnricher;
    readonly state: StateService; readonly deliveries: DeliveryService; readonly undo: UndoService; readonly mentions: MentionService;
    readonly presence: PresenceTracker; readonly notifications: NotificationService; readonly approvers: ApproverDirectory;
    readonly suggestions: SuggestionDecider;
    /** A/B compare: a message answered by several variants of the chat's settings, one chosen. */
    readonly compare: CompareService;
  };
  readonly index: {
    readonly embedders: Embedders; readonly indexer: Indexer; readonly search: Search; readonly suggest: Suggester;
    /** Where images are embedded (admins). */
    readonly images: ImageEmbeddingSettings;
  };
  readonly api: { readonly auth: Authenticator; readonly content: ContentStore; readonly push: PushService; readonly relay: EventRelay; readonly secrets: SecretVault;
    /** Build 8: the hub's display name. */
    readonly identity: HubIdentityService;
    /** SSO: sign-in through OpenID Connect providers. */
    readonly sso: SsoService;
    /** HTTPS on the hub's port: the switch and the certificate. */
    readonly https: HubHttps;
  };
  // build 2
  readonly contextor: ContextorServices;
  readonly resources: ResourceServices;
  readonly mcp: McpServices;
  readonly metrics: MetricsServices;
  readonly models: ModelServices;
  // build 4
  /** Who may see and use each system, fn, context item, resource root and connection. */
  readonly access: AccessService;
  /** Per-person connections to the systems that act as a person. */
  readonly connections: ConnectionService;
  // build 5
  /** Fns and context search, fn examples and facts, the chat fn mode gate, and browser logs. */
  readonly fns: FnsServices;
  // build 8
  /** The data system: records of stored types. */
  readonly data: DataService;
}

/** The updown component names, in start order. The lifecycle is typed by them, so a misspelt name or dependency cannot compile. */
export const COMPONENTS = {
  log: 'log',
  store: 'store',
  plugins: 'plugins',
  work: 'work',
  http: 'http',
  links: 'links',
  installed: 'installed',
} as const;

/** A lifecycle component's name. */
export type ComponentName = (typeof COMPONENTS)[keyof typeof COMPONENTS];

/** What a module does at a lifecycle component: `up` on start, `pre` first on stop (drain), `post` last (close). */
export interface StageHooks {
  up?(): Promise<void>;
  pre?(): Promise<void>;
  post?(): Promise<void>;
}

/** The modules other lanes build; boot builds the base services and the api module itself. */
export type ModuleKey = 'catalog' | 'link' | 'execution' | 'chat' | 'index' | 'contextor' | 'resources' | 'mcp' | 'metrics' | 'models' | 'access' | 'connections' | 'fns' | 'data';

/** What building a module gives the hub. */
export interface ModuleBuild<T> {
  readonly services: T;
  /** Work the module does as the hub starts and stops (`work`: queues; `links`: connections; `installed`: systems). */
  readonly hooks?: Partial<Record<Exclude<ComponentName, 'log' | 'store' | 'plugins' | 'http'>, StageHooks>>;
  /** The ayepi plugins it serves on the system link (`hubLinkSpec`), installed in this order. */
  readonly linkPlugins?: readonly AnyPlugin[];
}

/** What a module factory gets. */
export interface ModuleContext {
  /** Every service. A module reads others lazily (inside its methods), never while it is being built. */
  readonly hub: HubServices;
  /** The typed callers of connected systems (`systemLinkSpec`), shared by the link server and the link module. */
  readonly peers: Peers<SystemLinkSpec>;
  /** The hub's own actor (the author of hub notes, the owner of hub secrets). */
  readonly hubActor: ActorId;
  /** Signs the HTTP tokens linked systems get in their welcome (the hub JWT secret). */
  readonly systemTokens: SystemTokens;
}

/** Builds one module. Synchronous: anything slow goes in its hooks. */
export type ModuleFactory<K extends ModuleKey> = (context: ModuleContext) => ModuleBuild<HubServices[K]>;

/** A factory per module, and how to open the store. */
export type HubModules = { readonly [K in ModuleKey]: ModuleFactory<K> } & { readonly store: StoreFactory };

/** A running hub. */
export interface RunningHub {
  readonly services: HubServices;
  /** The port it listens on (the real one, if 0 was asked for). */
  readonly port: number;
  /** The base URL it answers on, on this machine. */
  readonly url: string;
  stop(): Promise<void>;
}

/** How to start a hub. Tests pass module fakes, a `:memory:` store, a fixed clock. */
export interface StartOptions {
  readonly modules: HubModules;
  readonly settings?: HubSettings;
  readonly clock?: () => number;
  /** Use this logger instead of making one (tests). */
  readonly log?: Logger;
  /** Listen on this port instead of `HARNESS_PORT` (0: any free port). */
  readonly port?: number;
  /** Handle SIGINT / SIGTERM / SIGBREAK (the process entry does; tests don't). */
  readonly signals?: boolean;
}

/** Start a hub. */
export type StartHub = (options: StartOptions) => Promise<RunningHub>;
