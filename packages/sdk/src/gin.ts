/**
 * Gin in the SDK. `g` is gin's own type builder (a gin `Registry`): every type made with it is a real, in-memory gin
 * type that carries the TypeScript type of its values, so `Infer<typeof t>` is exact. From a gin type you get its
 * JSON definition (`toJSON`), value parsing (`parse`), a zod value schema (`toValueSchema`) and the named types it
 * references (`references`). Named types a contract declares are registered in `g`, so they serialize by name.
 */
import { createRegistry, Type, type Infer, type Registry } from '@aeye/gin';
import { FN_NAME_PATTERN, GinTypeDef, Json, QualifiedName, type TypeDefinitions } from '@harness/core';

/** What the harness adds to gin's builder. */
export interface HarnessGin {
  /**
   * A text that holds a fn's qualified name. Code and people see `fs/read`; the model sees and writes `fs__read`, and the
   * hub converts it both ways at the boundary (core's `modelFnNames`). Its JSON schema says "a fn's name, as your tools
   * spell it". Use it for every field that names a fn (a fn to load, run or look at; a hit's or a result's fn).
   */
  fnName(): GinType<QualifiedName>;
}

const registry: Registry = createRegistry();

/** The gin type builder: gin's registry, shared by every contract in this process, with `fnName` (`HarnessGin`). */
export const g: Registry & HarnessGin = Object.assign(registry, {
  fnName: (): GinType<QualifiedName> => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the boundary reads every value of this text back to a qualified name before a fn gets it
    return registry.text({ pattern: FN_NAME_PATTERN }) as GinType<QualifiedName>;
  },
});

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

/** A wire type's generic parameter (`T` of optional and nullable, `V` of list), when it has one. */
function genericOf(def: GinTypeDef, key: string): GinTypeDef | undefined {
  return def.generic?.[key];
}

/** A wire type's options as a plain record, so each case reads only the options it knows. */
function optionsOf(def: GinTypeDef): Record<string, unknown> {
  const options: unknown = def.options;
  return typeof options === 'object' && options !== null ? { ...options } : {};
}

/** A number option, when the type sets it. */
function numOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  return typeof value === 'number' ? value : undefined;
}

/** gin's own zero value of a type (`create`), as JSON, for a shape `sampleOf` doesn't fill itself; `null` when it can't. */
function ginZero(def: GinTypeDef): Json {
  try {
    const type = g.parse(def);
    return encodeValue(type, type.create());
  } catch {
    return null;
  }
}

/**
 * A sample value of a wire type, for an example call a kind works out from a payload's args (`KindDescription.examples`):
 * every required field filled (text with its field's name, a number in range, the first enum value or union option, one
 * list item), optional fields left out. A shape it can't fill by itself (a named type) gets gin's own zero value
 * (`create`), which its type accepts. A patterned text is best effort, as in gin: no value is synthesized from a pattern.
 */
export function sampleOf(def: GinTypeDef, hint = 'example'): Json {
  const options = optionsOf(def);
  switch (def.name) {
    case 'optional':
    case 'nullable': {
      const inner = genericOf(def, 'T');
      return inner === undefined ? null : sampleOf(inner, hint);
    }
    case 'obj': {
      const out: Record<string, Json> = {};
      for (const [name, prop] of Object.entries(def.props ?? {})) {
        if (prop.type.name !== 'optional') { out[name] = sampleOf(prop.type, name); }
      }
      return out;
    }
    case 'list': {
      const item = genericOf(def, 'V');
      return item === undefined ? [] : [sampleOf(item, hint)];
    }
    case 'text': {
      const min = numOption(options, 'minLength') ?? 0;
      const max = numOption(options, 'maxLength');
      const text = hint.padEnd(min, 'a');
      return max === undefined ? text : text.slice(0, max);
    }
    case 'num': {
      const min = numOption(options, 'min');
      const max = numOption(options, 'max');
      const n = Math.min(Math.max(1, min ?? 1), max ?? Number.POSITIVE_INFINITY);
      return options['whole'] === true ? Math.ceil(n) : n;
    }
    case 'bool': return true;
    case 'any': return hint;
    case 'date': return '2026-01-31';
    case 'timestamp': return '2026-01-31T09:00:00Z';
    case 'literal': {
      const value = Json.safeParse(options['value']);
      return value.success ? value.data : ginZero(def);
    }
    case 'enum': {
      const values = options['values'];
      const first = Json.safeParse(typeof values === 'object' && values !== null ? Object.values(values)[0] : undefined);
      return first.success ? first.data : ginZero(def);
    }
    case 'or': {
      const types = GinTypeDef.array().safeParse(options['types']);
      const first = types.success ? types.data[0] : undefined;
      return first === undefined ? ginZero(def) : sampleOf(first, hint);
    }
    default: return ginZero(def);
  }
}

/** Sample args for a fn's args type (an `obj`, filled by `sampleOf`); open args (`any`) or any other shape give `{}`. */
export function sampleArgs(args: GinTypeDef): Record<string, Json> {
  if (args.name !== 'obj') { return {}; }
  const value = sampleOf(args);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
