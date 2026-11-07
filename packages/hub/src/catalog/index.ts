/**
 * The catalog module: what every system contributes, imported from manifests, and whether each thing can be used
 * now. It owns the gin scope the hub parses signatures in: named types are bound per system, in dependency order
 * (gin `typeClosure`), so a fn that names `fs/Entry` resolves it, and re-declared types must stay compatible (gin
 * `compatible`).
 *
 * Owner: the link lane (catalog and link are one lane). `StoreCatalog` (`catalog/catalog.ts`) implements `Catalog`.
 */
import type { Type } from '@aeye/gin';
import type {
  ActorId, Availability, ContextRecord, GinTypeDef, Json, FnDecl, FnRecord, ImportReport, KindDescription, KindRecord, Manifest, ManifestPatch, ManifestSection,
  QualifiedName, SectionDecl, SystemName, TypeRecord,
} from '@harness/core';
import type { z } from 'zod';

/** A fn's signature rebuilt as real gin types, with the zod and JSON schemas the LLM tool and the input form use. */
export interface FnSignature {
  readonly fn: QualifiedName;
  readonly args: Type;
  readonly returns: Type;
  /** `args.toValueSchema` with docs, unknown keys refused (an agent's call is authored against it). */
  readonly argsSchema: z.ZodType;
  readonly returnsSchema: z.ZodType;
  /** JSON schema of the args, for tool definitions and `!` forms. */
  readonly argsJsonSchema: Record<string, unknown>;
}

/** Asks a kind's system to check and describe a payload (over the link). */
export interface KindDescriber {
  describe(kind: QualifiedName, payload: Json): Promise<{ problems: string[]; description?: KindDescription | undefined }>;
}

/** One entry of a manifest section, qualified by its system. */
export interface CatalogEntry<S extends ManifestSection> {
  readonly name: QualifiedName;
  readonly system: SystemName;
  readonly decl: SectionDecl<S>;
}

/** What the catalog knows and works out. */
export interface Catalog {
  /** Import a whole manifest: add, update and remove what changed; refuse what is invalid or incompatible. */
  importManifest(manifest: Manifest): Promise<ImportReport>;
  importPatch(system: SystemName, patch: ManifestPatch): Promise<ImportReport>;
  /** Import the stored manifest again: re-check every entry and ask kinds to describe their fns afresh. */
  reimport(system: SystemName): Promise<ImportReport>;
  /** A system connected, disconnected, was configured or removed: recompute availability of everything it touches. */
  refreshAvailability(system: SystemName): Promise<void>;

  /** The last manifest accepted from a system (refused entries left out). */
  manifest(system: SystemName): Promise<Manifest | undefined>;
  /** The entries of one manifest section, across systems or for one. */
  entries<S extends ManifestSection>(section: S, filter?: { system?: SystemName }): Promise<Array<CatalogEntry<S>>>;

  fn(name: QualifiedName): Promise<FnRecord | undefined>;
  fns(filter: { system?: SystemName; names?: readonly QualifiedName[]; available?: boolean }): Promise<FnRecord[]>;
  kind(name: QualifiedName): Promise<KindRecord | undefined>;
  type(name: QualifiedName): Promise<TypeRecord | undefined>;
  /** The named types a type refers to, transitively, dependencies first, with any it couldn't find. */
  typeClosure(names: readonly QualifiedName[]): Promise<{ order: QualifiedName[]; missing: QualifiedName[] }>;
  context(name: QualifiedName): Promise<ContextRecord | undefined>;
  availability(name: QualifiedName): Promise<Availability>;

  /** A fn's signature as gin types and schemas, parsed in its system's scope. Cached per fn version. */
  signature(fn: QualifiedName): Promise<FnSignature>;
  /** Check a value against a gin type definition in a system's scope; returns the problems, empty when valid. */
  check(system: SystemName, type: GinTypeDef, value: unknown): Promise<string[]>;

  /** Declare a fn while running (`hub/declare_fn` or a system's `add`). Fns of a kind are described by the kind's system. */
  declare(system: SystemName, decl: FnDecl, by: ActorId): Promise<ImportReport>;
}
