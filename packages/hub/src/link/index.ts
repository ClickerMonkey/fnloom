/**
 * The link module: system connections over `/link` (ayepi peers on `hubLinkSpec` / `systemLinkSpec`), the hello /
 * challenge / pairing handshake, manifest import (through the catalog), each system's config, lifecycle calls, and
 * the supervisor that installs, starts and restarts installed systems.
 *
 * Owner: the link lane. Implement `LinkService` (`link/service.ts`), `PairingService`, `ConfigService` and
 * `Supervisor` (`link/supervisor.ts`), plus the hub link handlers (an ayepi plugin on `hubLinkSpec`).
 */
import type { Peer } from '@ayepi/core';
import type {
  ActorId, ConfigValue, InstallSource, InstalledSystem, Json, PairingId, PairingRequest, StopReason, SystemLinkSpec, SystemName, SystemRecord, Timestamp,
} from '@harness/core';

/** One connected system: who it is and how to call it. */
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
