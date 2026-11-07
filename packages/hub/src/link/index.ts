/**
 * The link module: system connections over `/link` (ayepi peers on `hubLinkSpec` / `systemLinkSpec`), the hello /
 * challenge / pairing handshake, manifest import (through the catalog), each system's config, lifecycle calls, and
 * the supervisor that installs, starts and restarts installed systems.
 *
 * Owner: the link lane. `PeerLinkService` (`link/connections.ts`), `StorePairingService` (`link/pairing.ts`),
 * `StoreConfigService` (`link/config.ts`), `StoreSystemAdmin` (`link/systems.ts`), `PeerResourceRouter`
 * (`link/resources.ts`) and `ProcessSupervisor` (`link/supervisor.ts`) implement the interfaces below;
 * `linkHandlers` (`link/handlers.ts`) is the hub's side of `hubLinkSpec` that this module answers.
 */
import type { Peer } from '@ayepi/core';
import type {
  ActorId, ConfigValue, ImportReport, InstallSource, InstalledSystem, Json, LinkSession, Page, PairingId, PairingRequest, QualifiedName, ReadWant,
  ResourceChange, ResourceLink, ResourceRead, ResourceRoot, ResourceStat, ResourceUri, Section, StopReason, SystemEnabled, SystemLinkSpec, SystemName, SystemRecord,
  Timestamp,
} from '@harness/core';

/** One connected system: who it is and how to call it. */
export type { SystemOutput } from './output.ts';

export interface SystemConnection {
  readonly system: SystemName;
  readonly instance: string;
  readonly connectedAt: Timestamp;
  /** The typed caller for what the system serves (`systemLinkSpec`). */
  readonly peer: Peer<SystemLinkSpec>;
  /** Aborts when the connection closes. */
  readonly signal: AbortSignal;
}

/** Connected systems. */
export interface LinkService {
  /** The connection of a system, if it is connected now. */
  connection(system: SystemName): SystemConnection | undefined;
  connected(): readonly SystemConnection[];
  /** Wait until a system connects (or the signal aborts). */
  whenConnected(system: SystemName, signal?: AbortSignal): Promise<SystemConnection>;
  /** Ask every connected system to stop (shutdown), within the timeout. */
  stopAll(reason: StopReason, timeout: number): Promise<void>;
  /** Called with each connect and disconnect. Returns the unsubscribe. */
  onChange(listener: (change: { system: SystemName; connected: boolean }) => void): () => void;
}

/** Pairing: new names wait for an admin (code or token); known names prove their key. */
export interface PairingService {
  pending(): Promise<PairingRequest[]>;
  approve(pairing: PairingId, by: ActorId): Promise<SystemRecord>;
  reject(pairing: PairingId, by: ActorId): Promise<void>;
  /** A one-time token so a system can pair without a code. The token is shown once; only its hash is stored. */
  createToken(input: { name?: SystemName; expiresIn: number; by: ActorId }): Promise<{ token: string; expiresAt: Timestamp }>;
  /** The key an installed system gets, paired at install time. */
  pairInstalled(system: SystemName, publicKey: string, by: ActorId): Promise<SystemRecord>;
}

/** System config: checked against the contract's config type, versioned, and pushed to the system on change. */
export interface ConfigService {
  current(system: SystemName): Promise<ConfigValue | undefined>;
  /** Set a config; refused (with problems) unless valid for the system's config type. */
  set(system: SystemName, value: Json, by: ActorId): Promise<{ version: number } | { problems: string[] }>;
}

/** Installed systems: kept on disk under the data folder, started with the hub, restarted with backoff. */
export interface Supervisor {
  install(input: { source: InstallSource; config?: Json; autoStart?: boolean; by: ActorId }): Promise<InstalledSystem>;
  start(system: SystemName): Promise<void>;
  /** Stop: ask it to stop over the link with a deadline, then end the process if it hasn't. */
  stop(system: SystemName, reason: StopReason): Promise<void>;
  upgrade(system: SystemName, version?: string): Promise<{ from: string; to: string }>;
  uninstall(system: SystemName): Promise<void>;
  /** Start every installed system with `autoStart`. */
  startAll(): Promise<void>;
  stopAll(reason: StopReason): Promise<void>;
  list(): Promise<InstalledSystem[]>;
}

/** What an admin switches and removes, beyond config. */
export interface SystemAdmin {
  /** Turn a system's functions and renderers on or off, separately. Functions off makes its fns unavailable. */
  setEnabled(system: SystemName, change: Partial<SystemEnabled>, by: ActorId): Promise<SystemEnabled>;
  /** Remove a system: it is asked to stop, and its fns stay unavailable until it is paired again. */
  remove(system: SystemName, by: ActorId): Promise<{ fnsUnavailable: number }>;
  /** Import its stored manifest again (see `Catalog.reimport`) and recompute availability. */
  reimport(system: SystemName): Promise<ImportReport>;
}

/** Resources, routed to the connected system whose root holds each URI (the longest matching root wins). */
export interface ResourceRouter {
  /** Every root of every connected system that serves resources. */
  roots(): ReadonlyArray<{ readonly system: SystemName; readonly root: ResourceRoot }>;
  /** The system and root serving a URI, if one is connected. */
  route(uri: ResourceUri): { system: SystemName; root: ResourceRoot } | undefined;
  /** Ask the serving system for the roots it offers now (on connect, and when it says they changed). */
  refresh(system: SystemName): Promise<void>;
  read(uri: ResourceUri, want: readonly ReadWant[], signal?: AbortSignal): Promise<ResourceRead>;
  /** A resource's whole text and its links, with large text fetched from the system in chunks. */
  text(uri: ResourceUri, signal?: AbortSignal): Promise<{ stat: ResourceStat; text: string; links: ResourceLink[] }>;
  stat(uri: ResourceUri): Promise<ResourceStat | undefined>;
  list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>>;
  /** Cut a resource with a system's own sectioner. */
  sections(sectioner: QualifiedName, uri: ResourceUri, version: string): Promise<Section[]>;
  /** A system reported changes: keep those under its own roots and announce them (`resources.changed`). */
  changed(system: SystemName, changes: readonly ResourceChange[]): void;
}

/** Short-lived tokens a linked system uses for the hub's HTTP routes (asset upload, presigned content). */
export interface SystemTokens {
  issue(session: LinkSession): string;
}
