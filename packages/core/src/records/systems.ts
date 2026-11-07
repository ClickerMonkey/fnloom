/** The hub's records of systems: what is paired, installed and configured, and what each contributes. */
import { z } from 'zod';
import { ContextDecl, FnDecl, KindDecl, Manifest, TypeDecl } from '../manifest.ts';
import { ActorId, Duration, Json, PairingId, PairingTokenId, QualifiedName, SystemName, Timestamp, Usd } from '../primitives.ts';

/** Where a system is. `needs-config`: connected, but without a valid config, so it can't be used yet. */
export const SystemStatus = z.enum(['pairing', 'needs-config', 'connected', 'disconnected', 'removed']);
export type SystemStatus = z.infer<typeof SystemStatus>;

/** Where an installed system came from. */
export const InstallSource = z.union([
  z.object({ path: z.string() }),
  z.object({ package: z.string(), version: z.string() }),
  z.object({ git: z.string(), ref: z.string() }),
]);
export type InstallSource = z.infer<typeof InstallSource>;

/** How the hub restarts an installed system that exits. */
export const RestartPolicy = z.object({
  policy: z.enum(['always', 'on-failure', 'never']),
  backoff: Duration,
  /** Stop retrying after this many crashes in an hour. */
  maxPerHour: z.number().int().min(1),
});
export type RestartPolicy = z.infer<typeof RestartPolicy>;

/** The states of an installed system's process. */
export const InstalledStatus = z.enum(['installing', 'stopped', 'starting', 'running', 'crashed', 'disabled']);
export type InstalledStatus = z.infer<typeof InstalledStatus>;

/**
 * A system the hub installs, keeps on disk and starts itself. It is paired at install time (the hub makes its key),
 * starts when the hub starts, and is restarted if it crashes. Systems running elsewhere don't have one.
 */
export const InstalledSystem = z.object({
  name: SystemName,
  source: InstallSource,
  /** Its folder under the hub's data folder. */
  dir: z.string(),
  command: z.object({ run: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()), cwd: z.string().optional() }),
  version: z.string(),
  /** The last version that started cleanly; repeated crashes roll back to it. */
  goodVersion: z.string().optional(),
  autoStart: z.boolean(),
  restart: RestartPolicy,
  status: InstalledStatus,
  pid: z.number().int().optional(),
  /** The end of its output from its last exit, for the admin page. */
  lastExit: z.object({ code: z.number().int(), at: Timestamp, output: z.string() }).optional(),
  installedBy: ActorId,
  installedAt: Timestamp,
});
export type InstalledSystem = z.infer<typeof InstalledSystem>;

/** What an admin has switched on. Functions off keeps renderers drawing old messages; renderers off uses plain views. */
export const SystemEnabled = z.object({ functions: z.boolean(), renderers: z.boolean() });
export type SystemEnabled = z.infer<typeof SystemEnabled>;

/** The hub's row for a system. */
export const SystemRecord = z.object({
  name: SystemName,
  description: z.string(),
  status: SystemStatus,
  enabled: SystemEnabled,
  /** Its config, checked against the contract's config type. Absent until a valid value is set. */
  config: z.object({ value: Json, version: z.number().int().min(1), setBy: ActorId, setAt: Timestamp }).optional(),
  installed: InstalledSystem.optional(),
  /** A known name must prove it holds the key with this fingerprint. */
  keyFingerprint: z.string(),
  publicKey: z.string(),
  version: z.string(),
  manifestHash: z.string(),
  pairedAt: Timestamp.optional(),
  pairedBy: ActorId.optional(),
  lastSeenAt: Timestamp.optional(),
  address: z.string().optional(),
  actor: ActorId,
});
export type SystemRecord = z.infer<typeof SystemRecord>;

/** A pairing waiting for an admin. */
export const PairingRequest = z.object({
  id: PairingId,
  name: SystemName,
  keyFingerprint: z.string(),
  publicKey: z.string(),
  version: z.string(),
  address: z.string(),
  /** `code`: the admin compares the code the system printed. `token`: the system brought a one-time token. */
  method: z.enum(['code', 'token']),
  code: z.string().optional(),
  /** The name is paired to a different key; approving replaces that system. */
  replaces: SystemName.optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
export type PairingRequest = z.infer<typeof PairingRequest>;

/** A one-time token an admin creates so a system can pair without a code. */
export const PairingToken = z.object({
  id: PairingTokenId,
  /** The name it may claim; absent for any. */
  name: SystemName.optional(),
  tokenHash: z.string(),
  createdBy: ActorId,
  expiresAt: Timestamp,
  usedAt: Timestamp.optional(),
});
export type PairingToken = z.infer<typeof PairingToken>;

/**
 * The last manifest the hub accepted from a system, without the entries it refused. The hub keeps it so a system
 * whose manifest hash matches need not send it again, and so the sections without a table of their own (hooks,
 * mentions, embedders, sectioners, actions, settings, attachments, the config type) are known while it is offline.
 */
export const SystemManifest = z.object({ system: SystemName, manifest: Manifest, importedAt: Timestamp });
export type SystemManifest = z.infer<typeof SystemManifest>;

// ─── Catalog ──────────────────────────────────────────────────────────────────

/** Why a fn can't be called right now. */
export const FnUnavailable = z.enum([
  'system-needs-config', 'system-disconnected', 'system-removed', 'kind-missing', 'kind-system-disconnected', 'dep-unavailable', 'disabled', 'paused',
]);
export type FnUnavailable = z.infer<typeof FnUnavailable>;

/** Whether a fn (or anything else a system contributes) can be used now, and why not. */
export const Availability = z.union([z.literal(true), z.object({ unavailable: FnUnavailable, detail: z.string() })]);
export type Availability = z.infer<typeof Availability>;

/** Running numbers about a fn's runs. */
export const FnStats = z.object({ runs: z.number().int(), failures: z.number().int(), averageCost: Usd, averageTime: Duration, lastRunAt: Timestamp.optional() });
export type FnStats = z.infer<typeof FnStats>;

/** The hub's row for a fn. */
export const FnRecord = z.object({
  name: QualifiedName,
  system: SystemName,
  decl: FnDecl,
  /** Hash of the decl; runs record the version they used. */
  version: z.string(),
  /** `contract`: declared by its system. `runtime`: declared while running. */
  origin: z.enum(['contract', 'runtime']),
  addedBy: ActorId.optional(),
  available: Availability,
  /** Queued runs wait while paused (by an admin, or automatically after repeated failures). */
  paused: z.boolean(),
  disabled: z.boolean(),
  stats: FnStats,
  updatedAt: Timestamp,
});
export type FnRecord = z.infer<typeof FnRecord>;

/** The hub's row for a kind. */
export const KindRecord = z.object({ name: QualifiedName, system: SystemName, decl: KindDecl });
export type KindRecord = z.infer<typeof KindRecord>;

/**
 * The hub's row for a named type: its declaration, qualified, with its methods left to the fns named `Type.method`.
 * Types re-declared by a system must stay compatible (gin `compatible`).
 */
export const TypeRecord = TypeDecl.omit({ name: true, methods: true }).extend({
  name: QualifiedName,
  system: SystemName,
  /**
   * The named types its definition refers to directly (gin `typeReferences`), so a receiver can load them first. The
   * hub works these out from `def` itself; this is the only place they are kept.
   */
  references: z.array(QualifiedName),
  updatedAt: Timestamp,
});
export type TypeRecord = z.infer<typeof TypeRecord>;

/** Named type definitions, dependencies first, with the names asked for (or referred to) that the hub doesn't know. */
export const TypeDefinitions = z.object({ types: z.array(TypeRecord), missing: z.array(QualifiedName) });
export type TypeDefinitions = z.infer<typeof TypeDefinitions>;

/** The hub's row for context. */
export const ContextRecord = z.object({
  name: QualifiedName,
  system: SystemName,
  decl: ContextDecl,
  /** References found in the text (`@fs/read`), added to what loading brings along. */
  mentions: z.object({ context: z.array(QualifiedName), fns: z.array(QualifiedName) }),
  /** A source section changed since this was written. */
  stale: z.boolean(),
  updatedAt: Timestamp,
});
export type ContextRecord = z.infer<typeof ContextRecord>;
