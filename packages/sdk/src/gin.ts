/**
 * Gin in the SDK. `g` is gin's own type builder (a gin `Registry`): every type made with it is a real, in-memory gin
 * type that carries the TypeScript type of its values, so `Infer<typeof t>` is exact. From a gin type you get its
 * JSON definition (`toJSON`), value parsing (`parse`), a zod value schema (`toValueSchema`) and the named types it
 * references (`references`). Named types a contract declares are registered in `g`, so they serialize by name.
 */
import { createRegistry, type Infer, type Registry, type Type } from '@aeye/gin';
import { GinTypeDef, Json } from '@harness/core';

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

/**
 * A gin type's JSON definition, as it travels to the hub. gin's `toJSON` leaves keys whose value is `undefined`; a
 * JSON round trip drops them so the definition is plain JSON (library ask: gin should omit them itself).
 */
export function wireType(type: GinType): GinTypeDef {
  return GinTypeDef.parse(JSON.parse(JSON.stringify(type.toJSON())));
}

/**
 * Check a value against a gin type and return its plain JS form (what fns receive: dates as `Date`). Throws a
 * gin error naming the problem when the value doesn't fit.
 */
export function parseValue<T>(type: GinType<T>, value: unknown): T {
  return type.parse(value).toLogical();
}

/**
 * A checked value as JSON for the wire (dates as ISO strings). gin encodes an absent optional field as `null`, which
 * its own value schema refuses, so fields absent from the plain value are dropped (library ask: gin should omit them).
 */
export function encodeValue<T>(type: GinType<T>, value: T): Json {
  const checked = type.parse(value);
  return pruneAbsent(Json.parse(checked.encodeLogical()), checked.toLogical());
}

/** Drop the object keys of `encoded` whose value in `plain` is absent, recursively. */
function pruneAbsent(encoded: Json, plain: unknown): Json {
  if (Array.isArray(encoded)) {
    return Array.isArray(plain) ? encoded.map((item, i) => pruneAbsent(item, plain[i])) : encoded;
  }
  if (encoded === null || typeof encoded !== 'object' || typeof plain !== 'object' || plain === null || Array.isArray(plain) || plain instanceof Date || plain instanceof Map) {
    return encoded;
  }
  const source = new Map(Object.entries(plain));
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(encoded)) {
    if (source.has(key) && source.get(key) === undefined) { continue; }
    out[key] = pruneAbsent(item, source.get(key));
  }
  return out;
}

/** The named types a gin type refers to directly (gin `typeReferences`), so a receiver can load them first. */
export function referencesOf(type: GinType): string[] {
  return [...type.references().refs];
}
