/**
 * The link module: system connections over `/link` (ayepi peers on `hubLinkSpec` / `systemLinkSpec`), the hello /
 * challenge / pairing handshake, manifest import (through the catalog), each instance's config, lifecycle calls, the
 * supervisor that installs, starts and restarts installed instances, package zips and data exports, and fleets (many
 * instances of one system attached at once).
 *
 * Owner: the packaging lane. `PeerLinkService` (`link/connections.ts`), `StorePairingService` (`link/pairing.ts`),
 * `StoreConfigService` (`link/config.ts`), `StoreSystemAdmin` (`link/systems.ts`), `PeerResourceRouter`
 * (`link/resources.ts`), `ProcessSupervisor` (`link/supervisor.ts`), `HubPackages` (`link/packages.ts`) and
 * `FleetRouter` (`link/router.ts`) implement the interfaces below; `linkHandlers` (`link/handlers.ts`) is the hub's
 * side of `hubLinkSpec` that this module answers.
 */
import type { Peer } from '@ayepi/core';
import type {
  ActorId, AutoPairChoice, ConfigValue, ContentRef, ImportReport, InstallSource, InstalledSystem, InstanceName, InstanceRecord, InstanceRef, InvalidInput, Json, LinkSession,
  Page, PairingId, PairingRequest, QualifiedName, ReadWant, ResourceChange, ResourceLink, ResourceRead, ResourceRoot, ResourceStat, ResourceUri, Section,
  FnRouting, PairingGrant, PairingGrantRequest, SessionId, StopReason, SwitchItem, SystemEnabled, SystemLinkSpec, SystemName, Timestamp,
} from '@harness/core';

export type { SystemOutput } from './output.ts';

/** One connected instance of a system: who it is and how to call it. */
export interface SystemConnection {
  readonly system: SystemName;
  readonly instance: InstanceName;
  /** This process start of the instance (new on every start). */
  readonly boot: string;
  readonly connectedAt: Timestamp;
  /** The typed caller for what the instance serves (`systemLinkSpec`). */
  readonly peer: Peer<SystemLinkSpec>;
  /** Aborts when the connection closes. */
  readonly signal: AbortSignal;
}

/** An instance connected or went away. */
export interface ConnectionChange {
  readonly system: SystemName;
  readonly instance: InstanceName;
  readonly connected: boolean;
}

/** Connected instances. A system may have several connected at once (a fleet); each replaces only its own older connection. */
export interface LinkService {
  /**
   * The connection of one instance, if it is connected now. Without `instance`: the system's `main` instance if it is
   * connected, else the instance connected longest (callers that must pick for a fleet ask `InstanceRouter`).
   */
  connection(system: SystemName, instance?: InstanceName): SystemConnection | undefined;
  /** Every connected instance of a system, longest connected first. */
  connections(system: SystemName): readonly SystemConnection[];
  connected(): readonly SystemConnection[];
  /** Wait until a system (or one instance of it) connects, or the signal aborts. */
  whenConnected(system: SystemName, signal?: AbortSignal, instance?: InstanceName): Promise<SystemConnection>;
  /** Ask every connected instance to stop (shutdown), within the timeout. */
  stopAll(reason: StopReason, timeout: number): Promise<void>;
  /** Called with each connect and disconnect. Returns the unsubscribe. */
  onChange(listener: (change: ConnectionChange) => void): () => void;
}

/** What an admin chooses as they approve a pairing (the QR pairing page). */
export interface PairingChoice {
  /** The instance name to pair as, instead of the one the system asked for. */
  readonly instance?: InstanceName | undefined;
  /** The config to set, checked against the system's config type before anything is paired. */
  readonly config?: Json | undefined;
  /** Let the instance re-pair by itself (see `link/auto-pair.ts`): its secret goes out in its first welcome. */
  readonly autoPair?: AutoPairChoice | undefined;
}

/** Pairing: new instances wait for an admin (code or token); known instances prove their key. */
export interface PairingService {
  pending(): Promise<PairingRequest[]>;
  /** Build 6: a one-time token for an approved install run, bound to what was approved (`grantPairing`). */
  grant(request: PairingGrantRequest, link: InstanceRef): Promise<PairingGrant>;
  /**
   * A hosted instance said hello with its key (an update gets no token): when its host is running an approved install
   * of exactly this instance and contract, that install's folder, bundle and approval become its `host`, so the record
   * shows what runs now. A plain restart changes nothing.
   */
  rehosted(ref: InstanceRef, manifestHash: string): Promise<void>;
  /** One request, for the pairing page; refused when unknown. */
  get(pairing: PairingId): Promise<PairingRequest>;
  /** Pair the instance; with a config, it is checked first (refused with its problems) and set as it pairs. */
  approve(pairing: PairingId, by: ActorId, choice?: PairingChoice): Promise<InstanceRecord>;
  reject(pairing: PairingId, by: ActorId): Promise<void>;
  /** A one-time token so a system can pair without a code. The token is shown once; only its hash is stored. */
  createToken(input: { name?: SystemName; expiresIn: number; autoPair?: AutoPairChoice; by: ActorId }): Promise<{ token: string; expiresAt: Timestamp }>;
  /** The key an installed instance gets, paired at install time. */
  pairInstalled(ref: InstanceRef, publicKey: string, version: string, by: ActorId): Promise<InstanceRecord>;
}

/**
 * Instance config: checked against the contract's config type, versioned, and pushed to the instance on change.
 * Without `instance`, the system's default instance (`InstanceKeeper.defaultOf`).
 */
export interface ConfigService {
  current(system: SystemName, instance?: InstanceName): Promise<ConfigValue | undefined>;
  /** Set a config; refused (with problems) unless valid for the system's config type. */
  set(system: SystemName, value: Json, by: ActorId, instance?: InstanceName): Promise<{ version: number } | { problems: string[] }>;
}

/**
 * Installed instances: kept on disk under the data folder (`<systems>/<name>/versions/<version>` shared by the
 * system's instances, `<systems>/<name>/instances/<instance>/{state,data,cache}` each), started with the hub,
 * restarted with backoff. Calls without `instance` act on every installed instance of the system.
 */
export interface Supervisor {
  /**
   * Install an instance (see `ProcessSupervisor.install`); build 9 adds `fleet` and `description` (`InstallInput`).
   */
  install(input: InstallInput): Promise<InstalledSystem>;
  start(system: SystemName, instance?: InstanceName): Promise<void>;
  /** Stop: ask over the link with a deadline, then end the process if it hasn't. */
  stop(system: SystemName, reason: StopReason, instance?: InstanceName): Promise<void>;
  /** Fetch a new version and move every installed instance of the system to it (their data stays). */
  upgrade(system: SystemName, version?: string): Promise<{ from: string; to: string }>;
  /** Stop and forget installed instances; the package goes with the last one, and data folders stay. */
  uninstall(system: SystemName, instance?: InstanceName): Promise<void>;
  /** Start every installed instance with `autoStart`. */
  startAll(): Promise<void>;
  stopAll(reason: StopReason): Promise<void>;
  list(): Promise<InstalledSystem[]>;
}

/** What installing an instance takes. */
export interface InstallInput {
  readonly source: InstallSource;
  readonly config?: Json | undefined;
  readonly autoStart?: boolean | undefined;
  readonly instance?: InstanceName | undefined;
  readonly by: ActorId;
  /** Build 9: the system the source must hold (refused when it holds another). */
  readonly system?: SystemName | undefined;
  /** Build 9: refuse a package whose `system.json` says `instances: "one"` (an instance added from the browser). */
  readonly fleet?: boolean | undefined;
  /** Build 9: what the instance's row says about it (`InstanceRecord.description`). */
  readonly description?: string | undefined;
}

/** Package zips and data exports (the packaging slice and the CLI). */
export interface Packages {
  /**
   * Install a package zip from the content store: checked (format, protocol, every file's hash, no path leaving the
   * folder), placed under `versions/<version>`, paired, configured and started. A name already installed is refused
   * unless the package allows a fleet and the instance is new; `data` is a data export to restore into the instance.
   */
  installZip(input: { zip: ContentRef; instance?: InstanceName; config?: Json; data?: ContentRef; autoStart?: boolean; by: ActorId }): Promise<InstanceRef>;
  /**
   * Zip an instance's data folder with `export.json` and, only when `withSecrets` is set, `config.json` (the hub can't
   * tell secret config fields from others, so the config is left out unless asked for). Returns its content ref.
   */
  exportData(input: { ref: InstanceRef; withSecrets: boolean; by: ActorId }): Promise<ContentRef>;
  /** Forget one instance: stop it, uninstall it if the hub runs it, and mark it removed. */
  removeInstance(ref: InstanceRef, by: ActorId): Promise<void>;
}

/** What an admin switches and removes, beyond config. */
export interface SystemAdmin {
  /**
   * Turn a system's functions, renderers and context on or off, separately. Functions off makes its fns unavailable;
   * context off marks every context item of the system `systemOff`.
   */
  setEnabled(system: SystemName, change: Partial<SystemEnabled>, by: ActorId): Promise<SystemEnabled>;
  /** Turn one of a system's fns or context items on or off by itself. */
  switchItem(item: SwitchItem, by: ActorId): Promise<{ on: boolean }>;
  /** Remove a system and every instance: each is asked to stop, and its fns stay unavailable until one is paired again. */
  remove(system: SystemName, by: ActorId): Promise<{ fnsUnavailable: number }>;
  /** Import its stored manifest again (see `Catalog.reimport`) and recompute availability. */
  reimport(system: SystemName): Promise<ImportReport>;
}

/** A resource root and the instance serving it. */
export interface RoutedRoot {
  readonly system: SystemName;
  readonly instance: InstanceName;
  readonly root: ResourceRoot;
}

/**
 * Resources, routed to the connected instance whose root holds each URI (the longest matching root wins; in a fleet
 * the URI's authority names the instance, `file://laptop/…`, so each instance's roots are its own).
 */
export interface ResourceRouter {
  /** Every root of every connected instance that serves resources. */
  roots(): readonly RoutedRoot[];
  /** The instance and root serving a URI, if one is connected. */
  route(uri: ResourceUri): RoutedRoot | undefined;
  /** Ask a system's connected instances (or one) for the roots they offer now (on connect, and when they change). */
  refresh(system: SystemName, instance?: InstanceName): Promise<void>;
  read(uri: ResourceUri, want: readonly ReadWant[], signal?: AbortSignal): Promise<ResourceRead>;
  /** A resource's whole text and its links, with large text fetched from the instance in chunks. */
  text(uri: ResourceUri, signal?: AbortSignal): Promise<{ stat: ResourceStat; text: string; links: ResourceLink[] }>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  /** Cut a resource with a system's own sectioner (on the instance serving the URI when it is that system's). */
  sections(sectioner: QualifiedName, uri: ResourceUri, version: string): Promise<Section[]>;
  /** An instance reported changes: keep those under its own roots and announce them (`resources.changed`). */
  changed(link: InstanceRef, changes: readonly ResourceChange[]): void;
}

/** Short-lived tokens a linked system uses for the hub's HTTP routes (asset upload, presigned content). */
export interface SystemTokens {
  issue(session: LinkSession): string;
}

/** One call to place on a fleet: the executing system, the call's args, the caller's pick and the session. */
export interface RouteAsk {
  readonly system: SystemName;
  readonly args: Json;
  readonly on?: InstanceName | undefined;
  readonly session?: SessionId | undefined;
  /** The fn's own routing (`FnDecl.routing`): always one instance, or whichever is first available. */
  readonly routing?: FnRouting | undefined;
}

/** An instance a session is pinned to, or no pin for that system. */
export type InstancePin = InstanceRef | { readonly system: SystemName; readonly instance?: undefined };

/**
 * Which instance of a fleet runs a call. The instance is a hub-owned option, never a fn arg: an explicit `on`, else
 * the instance a resource URI in the args belongs to (`file://<instance>/…`), else the session's pinned instance,
 * else the system's default instance, else the only connected one; otherwise refused as invalid input naming the
 * choices. The run service asks once per run (hub-platform's one call site).
 */
export interface InstanceRouter {
  /** The instance of `system` (the system executing the fn, which is not always the one that declared it) for one call. */
  route(input: RouteAsk): Promise<{ instance: InstanceRef } | { invalid: InvalidInput }>;
  /** The connected instances of a system, for the `on` enum added to tool schemas when there is more than one. */
  connected(system: SystemName): readonly InstanceName[];
  /** Pin a session to an instance of a system (`/on laptop`), or clear the pin. */
  pin(session: SessionId, pin: InstancePin): void;
}
