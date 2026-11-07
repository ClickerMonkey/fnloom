/**
 * The boot module: the hub process. It parses the env slices, makes the logger (`@ayepi/log`, structured keys,
 * secrets redacted, console intercepted), opens the store, builds every module's service, installs the ayepi
 * plugins, and starts and stops it all in dependency order with `@ayepi/updown`.
 *
 * Owner: the api lane (with api). Implement `startHub` in `boot/start.ts` and `main.ts`.
 */
import type { Logger } from '@ayepi/log';
import type { Authenticator, ContentStore, EventRelay, PushService } from '../api/index.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import type { DeliveryService, MessageEnricher, ReplyRule, SessionService, StateService, TurnService, UndoService } from '../chat/index.ts';
import type { AgentLoop, Ledger, LimitResolver, LlmGateway, PolicyEngine, RunService } from '../execution/index.ts';
import type { Embedders, Indexer, Search, Suggester } from '../index/index.ts';
import type { ConfigService, LinkService, PairingService, Supervisor } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import type { HubSettings } from './env.ts';

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
  readonly link: { readonly connections: LinkService; readonly pairing: PairingService; readonly config: ConfigService; readonly supervisor: Supervisor };
  readonly execution: { readonly runs: RunService; readonly agents: AgentLoop; readonly llm: LlmGateway; readonly limits: LimitResolver; readonly ledger: Ledger; readonly policies: PolicyEngine };
  readonly chat: {
    readonly sessions: SessionService; readonly turns: TurnService; readonly reply: ReplyRule; readonly enrich: MessageEnricher;
    readonly state: StateService; readonly deliveries: DeliveryService; readonly undo: UndoService;
  };
  readonly index: { readonly embedders: Embedders; readonly indexer: Indexer; readonly search: Search; readonly suggest: Suggester };
  readonly api: { readonly auth: Authenticator; readonly content: ContentStore; readonly push: PushService; readonly relay: EventRelay };
}

/** The updown component names, in start order. One const so a misspelt dependency can't compile. */
export const COMPONENTS = {
  log: 'log',
  store: 'store',
  plugins: 'plugins',
  work: 'work',
  http: 'http',
  links: 'links',
  installed: 'installed',
} as const;

/** A running hub. */
export interface RunningHub {
  readonly services: HubServices;
  /** The port it listens on (the real one, if 0 was asked for). */
  readonly port: number;
  stop(): Promise<void>;
}

/** Start a hub. Tests pass overrides (a `:memory:` store, a fixed clock, fake providers). */
export type StartHub = (overrides?: Partial<Pick<HubServices, 'clock' | 'store'>>) => Promise<RunningHub>;
