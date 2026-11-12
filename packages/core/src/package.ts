/**
 * System packages, instances and data. A system is a folder with a `system.json` (this file's
 * `SystemPackageManifest`), a `server/` and an optional `client/`; `harness system pack` zips the built folder and the
 * hub installs the zip. The hub gives every installed instance its own state, data and cache folders outside the
 * package, so upgrades and rollbacks keep them; config lives in the hub's database, never in a file.
 */
import { z } from 'zod';
import { ConfigSecrets } from './config-secrets.ts';
import { GinTypeDef } from './gin.ts';
import { ActorId, ApprovalId, InstanceName, InstanceRef, Json, PairingId, QualifiedName, SystemName, Timestamp } from './primitives.ts';
import { CONTENT_HASH } from './resources.ts';
import { InstalledSystem, InstanceConfig, SystemStatus } from './records/systems.ts';

/** The package format this hub reads. */
export const PACKAGE_FORMAT = 1;

/** A semantic version: `1.4.0`, `2.0.0-beta.1`. */
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export type SemVer = z.infer<typeof SemVer>;

/** File names Windows keeps for devices (with any extension); neither Windows nor git can hold a file named so. */
const RESERVED_FILE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Whether one part of a package path is a plain file or folder name. */
const plainPart = (part: string): boolean => part !== '' && part !== '.' && part !== '..' && !RESERVED_FILE.test(part);

/**
 * A path inside a package: relative, forward slashes, no empty, `.` or `..` part, no drive or stream colon, and no
 * name Windows reserves, so it never leaves the folder and unpacks the same everywhere.
 */
export const PackagePath = z.string().min(1).refine(
  (path) => !path.includes('\\') && !path.includes(':') && path.split('/').every(plainPart),
  'A package path is relative, uses forward slashes and stays inside the package.',
);
export type PackagePath = z.infer<typeof PackagePath>;

/** The extra Node permissions a system asks for in `system.json`. */
export const SystemPermissions = z.object({ childProcess: z.boolean(), workers: z.boolean() });
export type SystemPermissions = z.infer<typeof SystemPermissions>;

/**
 * `system.json`: what a system package is. The one source of truth for a system's name, version and entries; its
 * contract's name must equal `name` (`harness system build` and `serve()` check it).
 */
export const SystemPackageManifest = z.object({
  format: z.literal(PACKAGE_FORMAT),
  name: SystemName,
  version: SemVer,
  description: z.string(),
  /** The link protocol it speaks (`LINK_PROTOCOL`); the hub refuses a package it can't talk to. */
  protocol: z.number().int().min(1),
  server: z.object({
    /** `server/main.ts` in source, `server/main.js` once built. */
    entry: PackagePath,
    /** npm packages left out of the bundle (native addons), by version range; the installer installs these. */
    external: z.record(z.string(), z.string()).default({}),
    /** The Node versions it runs on (a semver range). */
    node: z.string().optional(),
  }),
  client: z.object({ entry: PackagePath }).optional(),
  /** `one`: a single instance named `main`. `many`: a fleet; each attached copy is an instance. */
  instances: z.enum(['one', 'many']).default('one'),
  /** sha-256 of every packed file, written by `pack` and checked by install (corruption, not malice). */
  files: z.record(PackagePath, z.string().regex(CONTENT_HASH)).optional(),
  /**
   * What the process may do beyond reading its bundle and writing its own folders, under Node's permission
   * model (each absent is false). The install card shows these; without them a hosted system can't start child
   * processes or workers.
   */
  permissions: SystemPermissions.partial().optional(),
});
export type SystemPackageManifest = z.infer<typeof SystemPackageManifest>;

/** The file name of a package's manifest. */
export const PACKAGE_MANIFEST_FILE = 'system.json';

/** The folders the hub gives an installed instance (all outside the package). Cache is never exported. */
export const InstanceDirs = z.object({ state: z.string(), data: z.string(), cache: z.string() });
export type InstanceDirs = z.infer<typeof InstanceDirs>;

/**
 * The hub's row for one instance of a system (key `[system, instance]`): its key, what it runs, its config, its
 * status and, when the hub runs it, its process and folders. The one place each of these facts lives.
 */
/** The system instance that hosts another, and what it runs. */
export const HostedBy = z.object({
  host: InstanceRef,
  /** The source folder on the host's machine. */
  path: z.string().min(1),
  bundleHash: z.string().min(1),
  approval: ApprovalId,
});
export type HostedBy = z.infer<typeof HostedBy>;

export const InstanceRecord = z.object({
  system: SystemName,
  instance: InstanceName,
  /** What the instance said about itself (its machine, its purpose); shown beside its name. */
  description: z.string(),
  status: SystemStatus,
  /** A known instance must prove it holds the key with this fingerprint. */
  keyFingerprint: z.string(),
  publicKey: z.string(),
  version: z.string(),
  manifestHash: z.string(),
  /** Its config. Absent until a valid value is set. */
  config: InstanceConfig.optional(),
  /** Set for an instance the hub installed and runs: its process. */
  installed: InstalledSystem.optional(),
  /**
   * Set for an instance another system builds and runs (installed from the chat through `fs/install_system`):
   * who hosts it, from which folder, which bundle, and the approval it was started on. The hub's admin start, stop and
   * restart for it go to the host's fns.
   */
  host: HostedBy.optional(),
  /** Set for an instance the hub installed: its state, data and cache folders. */
  dirs: InstanceDirs.optional(),
  pairedAt: Timestamp.optional(),
  pairedBy: ActorId.optional(),
  lastSeenAt: Timestamp.optional(),
  address: z.string().optional(),
});
export type InstanceRecord = z.infer<typeof InstanceRecord>;

/**
 * One instance of a system as its own fleet sees it (`fleet` on the hub link): whether it is online, its config with
 * each secret field as `SECRET_KEPT`, and the types it owns (`TypeDecl.instance`), so one instance can choose which
 * of them a request is for (a database system picking the database).
 */
export const FleetInstance = z.object({
  instance: InstanceName,
  description: z.string(),
  online: z.boolean(),
  /** Its config with secret fields as `SECRET_KEPT`; null until one is set. */
  config: Json,
  types: z.array(z.object({ name: QualifiedName, description: z.string() })),
});
export type FleetInstance = z.infer<typeof FleetInstance>;

/**
 * What a system tells the hub while it waits for pairing, so the pairing page can show it and its config form before
 * the manifest is sent (`pairingInfo` on the link).
 */
export const PairingInfo = z.object({
  pairing: PairingId,
  description: z.string(),
  instance: InstanceName,
  /** Its config type, so the page can ask for config at approval. */
  configType: GinTypeDef.optional(),
  /** Its config's secret fields, which the pairing page asks for as passwords and the hub seals. */
  configSecrets: ConfigSecrets.optional(),
});
export type PairingInfo = z.infer<typeof PairingInfo>;

/** The `export.json` inside a data export zip (beside `data/` and `config.json`). */
export const SystemDataExport = z.object({
  format: z.literal(PACKAGE_FORMAT),
  system: SystemName,
  instance: InstanceName,
  version: z.string(),
  exportedAt: Timestamp,
  exportedBy: ActorId,
  /** Whether `config.json` holds the secret fields (only when the admin asked and confirmed). */
  withSecrets: z.boolean(),
});
export type SystemDataExport = z.infer<typeof SystemDataExport>;


/** The file name of a package zip: `fs-0.2.0.zip` (what `harness system pack` writes). */
export function packageFileName(system: SystemName, version: string): string {
  return `${system}-${version}.zip`;
}

/** The file name of a data export: `fs-laptop-data.zip` (what `harness system export-data` and the hub download). */
export function dataExportFileName(ref: InstanceRef): string {
  return `${ref.system}-${ref.instance}-data.zip`;
}
