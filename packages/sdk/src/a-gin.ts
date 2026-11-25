/**
 * A gin type read off an `@aeye/schema` schema: what a schema from outside (an MCP tool's input or output, an
 * elicitation's form, read with `a.fromJSONSchema`) is to the harness, whose fns declare their args and results as gin
 * types. The mirror of `zod-gin.ts`'s `ginOf`, with the same rules:
 *
 * objects (with field descriptions as docs), strings (with lengths), numbers (with bounds and whole numbers), booleans,
 * null, literals, enums, arrays, unions, optional (and defaults, optional on input), nullable, records over open keys
 * (the harness's `record<V>`, `g.record`; an object of only extra keys is one), records over a closed set of keys (an
 * object with one optional field per key), refs (the bundle's named types, followed; a ref back into one being read is
 * any JSON, since a gin type here has no name to recur by), intersections of objects (merged). Anything else (JSON
 * values, `not`, conditionals, codecs, …) is any JSON: the side that owns the schema checks the value itself.
 */
import {
  ArrayType, DefaultType, EnumType, IntersectionType, LiteralType, NullableType, NumberType, ObjectType, OptionalType, RecordType, RefType, StringType, UnionType,
  type AnySchema,
} from '@aeye/schema';
import type { FieldsInput } from '@aeye/gin';
import { g, json, type GinType } from './gin.ts';

/** The named types refs resolve in (a bundle's `defs`). */
export type ANamedTypes = Readonly<Record<string, AnySchema>>;

/**
 * The schema classes this reads, each with its parts typed as schemas (`instanceof` alone leaves a generic class's parts
 * `any`).
 */
type Wrapper = OptionalType<AnySchema> | DefaultType<AnySchema> | NullableType<AnySchema>;
const isRef = (s: AnySchema): s is RefType<string> => s instanceof RefType;
const isWrapper = (s: AnySchema): s is Wrapper => s instanceof OptionalType || s instanceof DefaultType || s instanceof NullableType;
const isLiteral = (s: AnySchema): s is LiteralType<string | number | boolean | null> => s instanceof LiteralType;
const isEnum = (s: unknown): s is EnumType<readonly [string, ...string[]]> => s instanceof EnumType;
const isArray = (s: AnySchema): s is ArrayType<AnySchema> => s instanceof ArrayType;
const isUnion = (s: AnySchema): s is UnionType<readonly [AnySchema, ...AnySchema[]]> => s instanceof UnionType;
const isRecord = (s: AnySchema): s is RecordType<AnySchema> => s instanceof RecordType;
const isObject = (s: AnySchema | undefined): s is ObjectType<Readonly<Record<string, AnySchema>>, AnySchema | undefined> => s instanceof ObjectType;
const isIntersection = (s: AnySchema): s is IntersectionType<readonly [AnySchema, ...AnySchema[]]> => s instanceof IntersectionType;

/** A literal value as gin types it. */
function literalOf(value: unknown): GinType {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return g.literal(value);
  return value === null ? g.null() : json();
}

/** The description of a schema, when it is plain text. */
function docsOf(schema: AnySchema): string | undefined {
  const text = schema.meta.description;
  return typeof text === 'string' ? text : undefined;
}

/** A schema with its refs followed through `defs` (the ref itself when it names none, or one being read). */
function resolved(schema: AnySchema, defs: ANamedTypes, reading: ReadonlySet<string>): AnySchema | undefined {
  let at = schema;
  const seen = new Set<string>();
  while (isRef(at)) {
    const name = at.name;
    const next = defs[name];
    if (next === undefined || reading.has(name) || seen.has(name)) return undefined;
    seen.add(name);
    at = next;
  }
  return at;
}

/**
 * The gin type of an `a` schema, refs resolved in `defs`. Never throws: what gin can't say is any JSON.
 *
 * ```ts
 * const read = a.fromJSONSchema(tool.inputSchema);
 * const type = ginOfA(read.root, read.defs);
 * ```
 */
export function ginOfA(schema: AnySchema, defs: ANamedTypes = {}, reading: ReadonlySet<string> = new Set()): GinType {
  const of = (inner: AnySchema): GinType => ginOfA(inner, defs, reading);
  if (isRef(schema)) {
    const target = resolved(schema, defs, reading);
    return target === undefined ? json() : ginOfA(target, defs, new Set([...reading, schema.name]));
  }
  if (isWrapper(schema)) return schema instanceof NullableType ? g.nullable(of(schema.inner)) : g.optional(of(schema.inner));
  if (schema instanceof StringType) {
    const { minLength, maxLength } = schema.options;
    return g.text({ ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }) });
  }
  if (schema instanceof NumberType) {
    const { int, minimum, maximum } = schema.options;
    return g.num({ ...(int === true ? { whole: true } : {}), ...(minimum === undefined ? {} : { min: minimum }), ...(maximum === undefined ? {} : { max: maximum }) });
  }
  if (schema.kind === 'boolean') return g.bool();
  if (schema.kind === 'null') return g.null();
  if (isLiteral(schema)) return literalOf(schema.value);
  if (isEnum(schema)) return g.enum([...schema.values]);
  if (isArray(schema)) return g.list(of(schema.element));
  if (isUnion(schema)) return g.or(schema.options.map(of));
  if (isRecord(schema)) return recordOf(schema, of);
  if (isObject(schema)) {
    const rest = schema.extras.rest;
    if (Object.keys(schema.shape).length === 0 && rest !== undefined) return g.record(of(rest));
    return g.obj(fieldsOf(schema.shape, of));
  }
  if (isIntersection(schema)) return merged(schema.members, defs, reading, of);
  return json();
}

/** A record: over a closed set of keys, an object with an optional field per key; over open keys, `record<V>`. */
function recordOf(schema: RecordType<AnySchema>, of: (inner: AnySchema) => GinType): GinType {
  const value = of(schema.value);
  const key = schema.key;
  if (!isEnum(key)) return g.record(value);
  const names = key.values;
  const docs = docsOf(schema.value);
  const field = g.optional(value);
  return g.obj(Object.fromEntries(names.map((name) => [name, docs === undefined ? field : g.field(field, { docs })])));
}

/** An object's fields as gin fields, each with its description as docs. */
function fieldsOf(shape: Readonly<Record<string, AnySchema>>, of: (inner: AnySchema) => GinType): FieldsInput {
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => {
    const type = of(field);
    const docs = docsOf(field) ?? (isWrapper(field) ? docsOf(field.inner) : undefined);
    return [name, docs === undefined ? type : g.field(type, { docs })];
  }));
}

/** An intersection of objects as one object of all their fields (a later one's field wins); else any JSON. */
function merged(options: readonly AnySchema[], defs: ANamedTypes, reading: ReadonlySet<string>, of: (inner: AnySchema) => GinType): GinType {
  const shape: Record<string, AnySchema> = {};
  for (const option of options) {
    const target = resolved(option, defs, reading);
    if (!isObject(target)) return json();
    Object.assign(shape, target.shape);
  }
  return g.obj(fieldsOf(shape, of));
}
