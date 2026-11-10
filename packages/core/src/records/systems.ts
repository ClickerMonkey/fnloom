/** The hub's records of systems: what is paired, installed and configured, and what each contributes. */
import { z } from 'zod';
import { ContextDecl, FnDecl, KindDecl, Manifest, TypeDecl } from '../manifest.ts';
import { ContextOrigin, ContextTokens } from '../context-graph.ts';
import { GinTypeDef } from '../gin.ts';
import { ActorId, Duration, InstanceName, Json, PairingId, PairingTokenId, QualifiedName, SystemName, Timestamp } from '../primitives.ts';
import { CONTENT_HASH } from '../resources.ts';
import { FnMetrics, noOutcomes, OutcomeCounts } from '../metrics.ts';
import { AutoPairChoice } from '../auto-pair.ts';
import { ConfigSecrets } from '../config-secrets.ts';

/**
 * Where an instance is. `needs-config`: connected, but without a valid config, so it can't be used yet. A system's
 * status is worked out from its instances (`systemStatus` in the hub's link module).
 */
export const SystemStatus = z.enum(['pairing', 'needs-config', 'connected', 'disconnected', 'removed']);
export type SystemStatus = z.infer<typeof SystemStatus>;

/** Where an installed system came from. */
export const InstallSource = z.union([
  z.object({ path: z.string() }),
  z.object({ package: z.string(), version: z.string() }),
  z.object({ git: z.string(), ref: z.string() }),
  /** An uploaded package zip (`harness system pack`): its content hash and the file name it came as. */
  z.object({ zip: z.string().regex(CONTENT_HASH), file: z.string() }),
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
 * An instance the hub installs, keeps on disk and starts itself. It is paired at install time (the hub makes its key),
 * starts when the hub starts, and is restarted if it crashes. Instances running elsewhere don't have one.
 */
export const InstalledSystem = z.object({
  name: SystemName,
  instance: InstanceName,
  source: InstallSource,
  /** The system's folder under the hub's data folder (`versions/` shared by its instances, `instances/` each). */
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

/** An instance's config, checked against the contract's config type. */
export const InstanceConfig = z.object({ value: Json, version: z.number().int().min(1), setBy: ActorId, setAt: Timestamp });
export type InstanceConfig = z.infer<typeof InstanceConfig>;

/**
 * Build 1 kept one instance's facts on the system's row. They are read once, by the migration that moves them onto
 * the system's `main` instance (`InstanceRecord`), and cleared; nothing else reads or writes them.
 */
export const LegacyInstanceFields = z.object({
  /** @deprecated moved to `InstanceRecord.keyFingerprint`. */
  keyFingerprint: z.string().optional(),
  /** @deprecated moved to `InstanceRecord.publicKey`. */
  publicKey: z.string().optional(),
  /** @deprecated moved to `InstanceRecord.config`. */
  config: InstanceConfig.optional(),
  /** @deprecated moved to `InstanceRecord.pairedAt`. */
  pairedAt: Timestamp.optional(),
  /** @deprecated moved to `InstanceRecord.pairedBy`. */
  pairedBy: ActorId.optional(),
  /** @deprecated moved to `InstanceRecord.lastSeenAt`. */
  lastSeenAt: Timestamp.optional(),
  /** @deprecated moved to `InstanceRecord.address`. */
  address: z.string().optional(),
});
export type LegacyInstanceFields = z.infer<typeof LegacyInstanceFields>;

/**
 * The hub's row for a system: what is true of the system whatever copy runs it. Each attached copy is an instance with
 * its own key, config, status and folders (`InstanceRecord`, table `instances`).
 */
export const SystemRecord = z.object({
  name: SystemName,
  description: z.string(),
  /** Worked out from its instances: connected when one is, else needs config, else disconnected; removed when all are. */
  status: SystemStatus,
  enabled: SystemEnabled,
  /** The newest version an instance said it runs. */
  version: z.string(),
  /** The hash of the manifest the catalog accepted (blank when something was refused, so it is sent again). */
  manifestHash: z.string(),
  /** Where a run goes when neither its args nor its session pick an instance (fleets). */
  defaultInstance: InstanceName.optional(),
  actor: ActorId,
}).extend(LegacyInstanceFields.shape);
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
  /** The instance is paired to a different key; approving replaces that instance's key. */
  replaces: SystemName.optional(),
  /** What the system said about itself while waiting (`pairingInfo`): shown on the pairing page. */
  description: z.string().optional(),
  /** The instance it asks to be (from its hello); the admin may rename it when approving. */
  instance: InstanceName.optional(),
  /** Its config type, so the pairing page asks for config at approval. */
  configType: GinTypeDef.optional(),
  /** Its config's secret fields (`PairingInfo.configSecrets`), sealed when the admin picks a config at approval. */
  configSecrets: ConfigSecrets.optional(),
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
  /** The instance it pairs may re-pair by itself (build 3): its secret is granted in the first welcome. */
  autoPair: AutoPairChoice.optional(),
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

/**
 * Running numbers about a fn's runs: how many ended each way, the running means of cost, run time and queue wait, the
 * tokens they used, and `p95`, the 95th percentile run time over the last week from the daily metrics. The fields it
 * shares with `FnMetrics` are `FnMetrics`' own. A build 1 row (which counted runs otherwise) starts its counts again.
 */
export const FnStats = FnMetrics.pick({ averageCost: true, averageQueued: true, p95: true, lastRunAt: true }).extend({
  outcomes: OutcomeCounts.default(noOutcomes),
  averageTime: Duration,
  tokens: FnMetrics.shape.tokens.default(0),
});
export type FnStats = z.infer<typeof FnStats>;

/** The numbers of a fn that hasn't run yet. */
export function noFnStats(): FnStats {
  return { outcomes: noOutcomes(), averageCost: 0, averageTime: 0, tokens: 0 };
}

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

/** The hub's row for context: declared by a system, written as memory, or made from a resource. */
export const ContextRecord = z.object({
  name: QualifiedName,
  /** The owning system; `hub` for memory and resource context. */
  system: SystemName,
  /** Where it came from; absent means declared by its system. */
  origin: ContextOrigin.optional(),
  decl: ContextDecl,
  /** Estimated tokens of the full content and of the summary; absent until the contextor sizes it. */
  tokens: ContextTokens.optional(),
  /** Turned off by a person (`hub/forget` disables memory); left out of every selection and search. */
  disabled: z.boolean().optional(),
  /** References found in the text (`@fs/read`), added to what loading brings along. */
  mentions: z.object({ context: z.array(QualifiedName), fns: z.array(QualifiedName) }),
  /** A source section changed since this was written. */
  stale: z.boolean(),
  updatedAt: Timestamp,
});
export type ContextRecord = z.infer<typeof ContextRecord>;
