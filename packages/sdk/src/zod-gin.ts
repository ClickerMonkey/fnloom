/**
 * A gin type read off a zod schema, for fns whose args or result are a shape the hub already defines in zod (the hub's
 * admin fns take exactly the body of the web endpoint they stand for). The zod schema stays the one source of truth:
 * a value the gin type accepts is then parsed with the schema itself, which gives it its TypeScript type.
 *
 * Covered: objects (with field descriptions), strings and string formats, template literals, numbers (with bounds and
 * whole numbers), booleans, literals, enums, arrays, unions (discriminated or not), optional, nullable,
 * defaults (optional on input), pipes (their input side), and records over a closed set of keys (an enum or literals),
 * which become an object with one field per key (optional for `z.partialRecord`). JSON, records over open keys,
 * `unknown` and lazy schemas become any JSON. A gin program (`GinExprDef`) becomes gin's `fn` type, whose value is an
 * expression: any JSON would refuse a program whose root is a `new` (gin reads that as a misplaced expression).
 */
import type { FieldsInput } from '@aeye/gin';
import { GinExprDef } from '@harness/core';
import { z } from 'zod';
import { g, json, type GinType } from './gin.ts';

/** zod's number formats that only hold whole numbers. */
const WHOLE_FORMATS: ReadonlySet<string> = new Set(['safeint', 'int32', 'uint32', 'int64', 'uint64']);

/** A literal value as gin types it. */
function literalOf(value: unknown): GinType {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return g.literal(value);
  if (value === null) return g.null();
  throw new Error(`zod-gin: a ${typeof value} literal has no gin type`);
}

/** A schema without its outer optional or default (what `.required()` makes of a field). */
function required(schema: z.core.$ZodType): z.core.$ZodType {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault ? schema.unwrap() : schema;
}

/** The input-side gin type of a zod schema; throws for a schema with no gin counterpart (a function, a promise). */
export function ginOf(schema: z.core.$ZodType): GinType {
  if (schema instanceof z.ZodOptional) return g.optional(ginOf(schema.unwrap()));
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) return g.optional(ginOf(schema.unwrap()));
  if (schema instanceof z.ZodReadonly || schema instanceof z.ZodCatch) return ginOf(schema.unwrap());
  if (schema instanceof z.ZodNonOptional) return ginOf(required(schema._zod.def.innerType));
  if (schema instanceof z.ZodNullable) return g.nullable(ginOf(schema.unwrap()));
  if (schema instanceof z.ZodPipe) return ginOf(schema.in);
  if (schema instanceof z.ZodObject) return g.obj(fieldsOf(schema));
  if (schema instanceof z.ZodArray) return g.list(ginOf(schema.element));
  if (schema instanceof z.ZodUnion) return g.or(schema.options.map((option) => ginOf(option)));
  if (schema instanceof z.ZodEnum) {
    const options = schema.options;
    return options.every((option) => typeof option === 'string') ? g.enum(options.filter((o) => typeof o === 'string')) : g.or(options.map(literalOf));
  }
  if (schema instanceof z.ZodLiteral) {
    const values = [...schema.values];
    const [only] = values;
    return values.length === 1 ? literalOf(only) : g.or(values.map(literalOf));
  }
  if (schema instanceof z.ZodNumber) {
    const whole = schema.format !== null && WHOLE_FORMATS.has(schema.format);
    const { minValue: min, maxValue: max } = schema;
    // a whole-number format bounds itself to the safe integers; only bounds the schema sets are worth saying
    return g.num({
      ...(whole ? { whole } : {}),
      ...(min === null || min <= Number.MIN_SAFE_INTEGER ? {} : { min }),
      ...(max === null || max >= Number.MAX_SAFE_INTEGER ? {} : { max }),
    });
  }
  if (schema instanceof z.ZodBoolean) return g.bool();
  if (schema instanceof z.ZodTemplateLiteral) return g.text();
  // every string format (`z.email()`, `z.url()`, branded ids) has def type `string`, whatever its class
  if (schema instanceof z.ZodString || schema._zod.def.type === 'string') {
    const length = schema instanceof z.ZodString ? { min: schema.minLength, max: schema.maxLength } : { min: null, max: null };
    return g.text({ ...(length.min === null ? {} : { minLength: length.min }), ...(length.max === null ? {} : { maxLength: length.max }) });
  }
  if (schema instanceof z.ZodNull) return g.null();
  if (schema instanceof z.ZodRecord) return recordOf(schema);
  if (schema === GinExprDef) return g.fn({ args: g.obj({}), returns: g.any() });
  if (schema instanceof z.ZodLazy || schema instanceof z.ZodUnknown || schema instanceof z.ZodAny || schema instanceof z.ZodCustom) return json();
  throw new Error(`zod-gin: a ${schema._zod.def.type} schema has no gin type`);
}

/**
 * `ginOf`, typed by the schema's input: the gin type is built from the schema's input side, so authors write
 * `z.input<S>` values into it. Records, `unknown` and lazy parts are any JSON in gin, so a reader parses the value with
 * the schema itself before trusting it (which also fills in defaults). Use it where a gin field must carry a core
 * schema's type, pinned with an `Equal` test.
 */
export function ginAs<S extends z.ZodType>(schema: S): GinType<z.input<S>> {
  return typedAs<z.input<S>>(ginOf(schema));
}

/**
 * A fn's args read off a zod schema. Tool args are always an object: an object schema is taken as it is, and a union
 * of objects (an import from a URL or from an upload, one provider of several) is flattened into one object with
 * every member's fields, so the model passes plain args either way; the schema itself picks the member when `read`
 * parses them. Any other schema is taken as the field `input`.
 */
export function toolArgsOf<S extends z.ZodType>(schema: S): { readonly args: GinType<ToolArgs<S>>; readonly read: (args: unknown) => z.output<S> } {
  if (schema instanceof z.ZodObject) return { args: typedAs<ToolArgs<S>>(ginOf(schema)), read: (args) => schema.parse(args) };
  const members = objectMembers(schema);
  if (members !== undefined) return { args: typedAs<ToolArgs<S>>(ginOf(flattened(members))), read: (args) => schema.parse(args) };
  return { args: typedAs<ToolArgs<S>>(g.obj({ input: ginOf(schema) })), read: (args) => schema.parse(Wrapped.parse(args).input) };
}

/** The keys of any member of a union. */
type KeysOf<U> = U extends unknown ? keyof U : never;

/** What a key holds in whichever members have it. */
type FieldOf<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;

/** A union of objects as one object: every member's fields, each one optional (the schema checks the member on read). */
export type FlatArgs<U> = { [K in KeysOf<U>]?: FieldOf<U, K> };

/**
 * The args a tool for a zod schema takes: the schema's input when it is an object, a union of objects flattened into
 * one, else that input as `input`.
 */
export type ToolArgs<S extends z.ZodType> = S extends z.ZodObject ? z.input<S> : S extends z.ZodUnion<readonly z.ZodObject[]> ? FlatArgs<z.input<S>> : { input: z.input<S> };

/** The members of a union whose members are all objects; undefined for any other schema. */
function objectMembers(schema: z.ZodType): z.ZodObject[] | undefined {
  if (!(schema instanceof z.ZodUnion)) return undefined;
  const members = schema.options.filter((option) => option instanceof z.ZodObject);
  return members.length === schema.options.length ? members : undefined;
}

/**
 * One object with every member's fields. A field is required only when every member requires it; a field whose
 * members differ (the discriminator's literals, say) takes any of their types.
 */
function flattened(members: readonly z.ZodObject[]): z.ZodObject {
  const shapes = members.map((member): Readonly<Record<string, z.core.$ZodType | undefined>> => member.shape);
  const keys = [...new Set(shapes.flatMap((fields) => Object.keys(fields)))];
  const shape: Record<string, z.core.$ZodType> = {};
  for (const key of keys) {
    const fields = shapes.flatMap((own) => { const field = own[key]; return field === undefined ? [] : [field]; });
    const optional = fields.length < members.length || fields.some((field) => field._zod.optin === 'optional');
    const [only, ...more] = [...new Set(fields.map(required))];
    if (only === undefined) continue;
    const type = more.length === 0 ? only : z.union([only, ...more]);
    shape[key] = optional ? z.optional(type) : type;
  }
  return z.object(shape);
}

/** A gin type built by `ginOf` from a schema whose input is `T`, given that type. */
function typedAs<T>(type: GinType): GinType<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- callers pass what ginOf built from a schema whose input is T
  return type as GinType<T>;
}

/** Args that carry a non-object value as `input`. */
const Wrapped = z.object({ input: z.unknown() });

/**
 * A record as gin types it: over a closed set of keys (an enum, literals) in strict mode, an object with a field per key,
 * each optional when the record is partial (zod requires every key otherwise); over open keys, any JSON, checked by
 * zod after (a gin map is a list of pairs, not an object).
 */
function recordOf(schema: z.ZodRecord): GinType {
  const keys = schema.keyType._zod.values;
  const { partial, mode } = schema._zod.def;
  if (keys === undefined || mode === 'loose') return json();
  const names = [...keys].flatMap((key) => typeof key === 'string' || typeof key === 'number' ? [String(key)] : []);
  if (names.length !== keys.size) return json();
  const value = ginOf(schema.valueType);
  const field = partial === true ? g.optional(value) : value;
  const docs = schema.valueType instanceof z.ZodType ? schema.valueType.description : undefined;
  return g.obj(Object.fromEntries(names.map((name) => [name, docs === undefined ? field : g.field(field, { docs })])));
}

/** An object's fields as gin fields, each with its description as docs. */
function fieldsOf(schema: z.ZodObject): FieldsInput {
  const shape: Readonly<Record<string, z.core.$ZodType>> = schema.shape;
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => {
    const type = ginOf(field);
    const docs = field instanceof z.ZodType ? field.description : undefined;
    return [name, docs === undefined ? type : g.field(type, { docs })];
  }));
}
