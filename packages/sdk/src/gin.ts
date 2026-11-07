/**
 * Gin in the SDK. `g` is gin's own type builder (a gin `Registry`): every type made with it is a real, in-memory gin
 * type that carries the TypeScript type of its values, so `Infer<typeof t>` is exact. From a gin type you get its
 * JSON definition (`toJSON`), value parsing (`parse`), a zod value schema (`toValueSchema`) and the named types it
 * references (`references`). Named types a contract declares are registered in `g`, so they serialize by name.
 */
import { createRegistry, type Infer, type Registry, type Type } from '@aeye/gin';
import { GinTypeDef, Json, QualifiedName } from '@harness/core';

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
  return type.parse(value).toLogical();
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
