/**
 * The harness's own gin type `record<V>`: a JSON object with any text keys, each value a `V` (zod's `z.record` over open
 * keys, such as a saved query's params by name). gin has no such type: its `map` is a list of `{key, value}` pairs, and
 * an open record used to become `any`, so a model was told nothing about its shape and the hub couldn't tell an
 * object was wanted there. A `record` value schema is `z.record(text, V)`, whose JSON schema is an object with
 * `additionalProperties` of `V`, and its values stay plain JSON objects (as `any`'s do): a fn gets what was sent.
 *
 * Every registry the harness parses types with defines it (`harnessRegistry`, or `defineHarnessTypes` on one made
 * elsewhere). A registry without it can't read a type that uses it, so make registries here.
 */
import { createRegistry, Type, TypeError as GinTypeError, Value, type CodeOptions, type Registry, type Rnd, type SchemaOptions, type TypeDef, type TypeScope } from '@aeye/gin';
import { z } from 'zod';

/** What a gin type's value schema takes (gin doesn't export the name). */
type ValueSchemaOptions = Parameters<Type['toValueSchema']>[0];

/**
 * A record's logical value, as gin types it: like `any`'s, whatever JSON was sent (gin's runtime forms are typed by
 * the value type, which plain JSON objects are not).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gin's own `any` is typed so; a record keeps plain JSON
type Plain = any;

/** Whether a value is a JSON object (not null, not a list, not a live Map). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map);
}

/** `record<V>`: an object with any text keys, each value a `V`, kept as plain JSON (as `any` keeps its values). */
export class RecordType extends Type<Plain, Record<string, never>> {
  static readonly NAME = 'record';
  readonly name = RecordType.NAME;

  /** `record` takes no options; its one type parameter is the values' type. */
  static readonly optionKeys = [] as const;
  static readonly genericKeys = ['V'] as const;

  static from(json: TypeDef, scope: TypeScope): RecordType {
    const value = json.generic?.['V'];
    return new RecordType(scope, value === undefined ? scope.registry.any() : scope.parse(value));
  }

  static toSchema(opts: SchemaOptions): z.ZodType {
    return z.object({ name: z.literal(RecordType.NAME), generic: z.object({ V: opts.Type }).optional() }).meta({ aid: 'Type_record' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodType {
    return z.record(z.string(), opts.Expr);
  }

  constructor(scope: TypeScope, value: Type) {
    super(scope, {}, { V: value });
  }

  /** The values' type. */
  get value(): Type {
    const value = this.generic['V'];
    if (value === undefined) throw new Error('record has no value type');
    return value;
  }

  valid(raw: unknown, scope?: TypeScope): raw is Record<string, unknown> {
    // a record's raw value is the plain JSON it was sent as, not gin's runtime form, so each value is checked by parsing it
    return isObject(raw) && Object.values(raw).every((item) => {
      try {
        this.value.parse(item, scope);
        return true;
      } catch {
        return false;
      }
    });
  }

  parse(json: unknown, scope?: TypeScope): Value {
    if (!isObject(json)) {
      throw new GinTypeError({ path: [], code: 'record.invalid', message: 'record.parse: expected an object of values by key', severity: 'error' });
    }
    // each value is checked by the values' type and kept as sent: a record's value is plain JSON
    for (const [key, item] of Object.entries(json)) {
      try {
        this.value.parse(item, scope);
      } catch (error) {
        throw new GinTypeError({ path: [key], code: 'record.value', message: `record.parse: ${key}: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
      }
    }
    return new Value(this, json);
  }

  encode(raw: Plain): Plain {
    return raw;
  }

  create(): Plain {
    return {};
  }

  random(_rnd: Rnd): Plain {
    return {};
  }

  compatibleType(other: Type): boolean {
    return other instanceof RecordType && this.value.compatibleType(other.value);
  }

  or(other: Type): Type {
    return other instanceof RecordType && this.value.compatibleType(other.value) ? this : other;
  }

  narrow(): Record<string, never> {
    return {};
  }

  toJSON(): TypeDef {
    return { name: RecordType.NAME, generic: { V: this.value.toJSON() } };
  }

  clone(): RecordType {
    return new RecordType(this.scope, this.value);
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return `${this.docsPrefix(options)}record<${this.value.toCode(undefined, options)}>`;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodType {
    return this.describeType(z.record(z.string(), this.value.toValueSchema(opts)), opts);
  }

  override toInstanceSchema(): z.ZodType {
    return z.looseObject({ name: z.literal(RecordType.NAME) });
  }
}

/** Define the harness's own gin types (`record`) on a registry; returns it. */
export function defineHarnessTypes<R extends Registry>(registry: R): R {
  if (registry.typeClass(RecordType.NAME) === undefined) registry.define(RecordType);
  return registry;
}

/** A gin registry of the built-in types and the harness's own (`record`): the one way the harness makes one. */
export function harnessRegistry(): Registry {
  return defineHarnessTypes(createRegistry());
}
