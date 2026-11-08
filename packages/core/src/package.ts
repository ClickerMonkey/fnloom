/**
 * System packages, instances and data. A system is a folder with a `system.json` (this file's
 * `SystemPackageManifest`), a `server/` and an optional `client/`; `harness system pack` zips the built folder and the
 * hub installs the zip. The hub gives every installed instance its own state, data and cache folders outside the
 * package, so upgrades and rollbacks keep them; config lives in the hub's database, never in a file.
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { ActorId, InstanceName, Json, PairingId, SystemName, Timestamp } from './primitives.ts';
import { CONTENT_HASH } from './resources.ts';
import { SystemStatus } from './records/systems.ts';

/** The package format this hub reads. */
export const PACKAGE_FORMAT = 1;

/** A semantic version: `1.4.0`, `2.0.0-beta.1`. */
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export type SemVer = z.infer<typeof SemVer>;

/** A path inside a package: relative, forward slashes, never escaping the folder. */
export const PackagePath = z.string().min(1).refine((path) => !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'), 'A package path is relative and stays inside the package.');
export type PackagePath = z.infer<typeof PackagePath>;

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
});
export type SystemPackageManifest = z.infer<typeof SystemPackageManifest>;

/** The file name of a package's manifest. */
export const PACKAGE_MANIFEST_FILE = 'system.json';

/** The folders the hub gives an installed instance (all outside the package). Cache is never exported. */
export const InstanceDirs = z.object({ state: z.string(), data: z.string(), cache: z.string() });
export type InstanceDirs = z.infer<typeof InstanceDirs>;

/** The hub's row for one instance of a system: where it is, what it runs, and its config. */
export const InstanceRecord = z.object({
  system: SystemName,
  instance: InstanceName,
  description: z.string(),
  status: SystemStatus,
  keyFingerprint: z.string(),
  publicKey: z.string(),
  version: z.string(),
  manifestHash: z.string(),
  /** Its config, checked against the contract's config type. Absent until a valid value is set. */
  config: z.object({ value: Json, version: z.number().int().min(1), setBy: ActorId, setAt: Timestamp }).optional(),
  /** Set for an instance the hub installed and runs. */
  dirs: InstanceDirs.optional(),
  pairedAt: Timestamp.optional(),
  pairedBy: ActorId.optional(),
  lastSeenAt: Timestamp.optional(),
  address: z.string().optional(),
});
export type InstanceRecord = z.infer<typeof InstanceRecord>;

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

