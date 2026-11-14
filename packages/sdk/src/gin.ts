/**
 * Gin in the SDK. `g` is gin's own type builder (a gin `Registry`): every type made with it is a real, in-memory gin
 * type that carries the TypeScript type of its values, so `Infer<typeof t>` is exact. From a gin type you get its
 * JSON definition (`toJSON`), value parsing (`parse`), a zod value schema (`toValueSchema`) and the named types it
 * references (`references`). Named types a contract declares are registered in `g`, so they serialize by name.
 */
import { createRegistry, Type, type Infer, type Registry } from '@aeye/gin';
import { GinTypeDef, Json, QualifiedName, type TypeDefinitions } from '@harness/core';

/** The gin type builder: gin's registry, shared by every contract in this process. */
export const g: Registry = createRegistry();

/** A gin type whose values are `T`. */
export type GinType<T = unknown> = Type<T>;

/** The TypeScript value of a gin type. */
export type { Infer };

/** Any JSON. The LLM and the input form get no structure from it, so prefer a real type. */
export function json(): GinType<Json> {
  return g.any();
}

/** A gin type's JSON definition, as it travels to the hub. */
export function wireType(type: GinType): GinTypeDef {
  return GinTypeDef.parse(type.toJSON());
}

/**
 * Check a value against a gin type and return its plain JS form (what fns receive: dates as `Date`). Throws a
 * gin error naming the problem when the value doesn't fit.
 */
export function parseValue<T>(type: GinType<T>, value: unknown): T {
  return definitionsOf(type.parse(value).toLogical());
}

/**
 * A plain value with each gin type in it (a `typ` value, which gin keeps as a live type) written as its JSON
 * definition, the form fns and the wire hold types in.
 */
function definitionsOf<T>(value: T): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a typ value's plain form is its definition, the TypeScript type fns declare
  return walk(value) as T;
}

/** `definitionsOf`, untyped: the same value back when nothing in it is a gin type. */
function walk(value: unknown): unknown {
  if (value instanceof Type) return value.toJSON();
  if (Array.isArray(value)) {
    const items = value.map(walk);
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    const walked = entries.map(([key, item]) => [key, walk(item)] as const);
    return walked.some(([, item], i) => item !== entries[i]?.[1]) ? Object.fromEntries(walked) : value;
  }
  return value;
}

/** A checked value as JSON for the wire (dates as ISO strings, absent optional fields left out). */
export function encodeValue<T>(type: GinType<T>, value: T): Json {
  return Json.parse(type.parse(value).encodeLogical());
}

/**
 * The named types a gin type refers to directly (gin `typeReferences`), so a receiver can load them first. Every named
 * type in `g` is registered under its qualified name, so a reference that isn't one throws. The hub works these out
 * for itself from the wire definition (`TypeRecord.references`); this is for code holding a live type.
 */
export function referencesOf(type: GinType): QualifiedName[] {
  return QualifiedName.array().parse(type.references().refs);
}

/** Named types loaded from the hub's definitions (`ctx.types.definitions`), as live gin types. */
export interface LoadedTypes {
  /** The gin type of a named type that loaded, ready to parse and encode values; `undefined` when it didn't. */
  get(name: QualifiedName): GinType | undefined;
  /** The names asked for (or referred to) that the hub doesn't know. */
  readonly missing: readonly QualifiedName[];
}

/**
 * Parse the hub's type definitions as gin types. The hub sends them dependencies first, so each is bound in a gin scope
 * overlay on `g` before anything that refers to it; nothing is registered process-wide. Throws a gin error when a
 * definition is invalid.
 */
export function loadTypes(definitions: TypeDefinitions): LoadedTypes {
  const scope = g.scope();
  const loaded = new Map<QualifiedName, GinType>();
  for (const record of definitions.types) {
    const type = scope.parse(record.def);
    scope.bind(record.name, type);
    loaded.set(record.name, type);
  }
  return { get: (name) => loaded.get(name), missing: definitions.missing };
}
