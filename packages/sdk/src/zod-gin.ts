/**
 * A gin type read off a zod schema, for fns whose args or result are a shape the hub already defines in zod (the hub's
 * admin fns take exactly the body of the web endpoint they stand for). The zod schema stays the one source of truth:
 * a value the gin type accepts is then parsed with the schema itself, which gives it its TypeScript type.
 *
 * Covered: objects (with field descriptions), strings and string formats, template literals, numbers (with bounds and
 * whole numbers), booleans, literals, enums, arrays, unions (discriminated or not), optional, nullable,
 * defaults (optional on input) and pipes (their input side). JSON, records, `unknown` and lazy schemas become any JSON.
 */
import type { FieldsInput } from '@aeye/gin';
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
  // a gin map is a list of pairs, not an object, so a record (an object of any keys) is any JSON, checked by zod after
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodLazy || schema instanceof z.ZodUnknown || schema instanceof z.ZodAny || schema instanceof z.ZodCustom) return json();
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
 * A fn's args read off a zod schema. Tool args are always an object, so a schema that isn't one (a union of shapes)
 * is taken as the field `input`; `read` turns args back into a value for the schema, checked by it.
 */
export function toolArgsOf<S extends z.ZodType>(schema: S): { readonly args: GinType<ToolArgs<S>>; readonly read: (args: unknown) => z.output<S> } {
  if (schema instanceof z.ZodObject) return { args: typedAs<ToolArgs<S>>(ginOf(schema)), read: (args) => schema.parse(args) };
  return { args: typedAs<ToolArgs<S>>(g.obj({ input: ginOf(schema) })), read: (args) => schema.parse(Wrapped.parse(args).input) };
}

/** The args a tool for a zod schema takes: the schema's input when it is an object, else that input as `input`. */
export type ToolArgs<S extends z.ZodType> = S extends z.ZodObject ? z.input<S> : { input: z.input<S> };

/** A gin type built by `ginOf` from a schema whose input is `T`, given that type. */
function typedAs<T>(type: GinType): GinType<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- callers pass what ginOf built from a schema whose input is T
  return type as GinType<T>;
}

/** Args that carry a non-object value as `input`. */
const Wrapped = z.object({ input: z.unknown() });

/** An object's fields as gin fields, each with its description as docs. */
function fieldsOf(schema: z.ZodObject): FieldsInput {
  const shape: Readonly<Record<string, z.core.$ZodType>> = schema.shape;
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => {
    const type = ginOf(field);
    const docs = field instanceof z.ZodType ? field.description : undefined;
    return [name, docs === undefined ? type : g.field(type, { docs })];
  }));
}
