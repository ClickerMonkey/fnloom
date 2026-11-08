/**
 * The type editor's model. A gin type definition (`GinTypeDef`, gin's `TypeDef` on the wire) is parsed into a live
 * gin type by the browser's type library and read into a `TypeShape` tree by gin's own classes (as `formOf` reads a
 * form): text and numbers with their constraints, the other scalars with their options, lists, maps, tuples, objects
 * with their fields, optionals, nullables, unions, enums, literals, references to named types, and a named type's
 * own definition at the root. Edits change the shape; `buildShape` turns it back into a gin type with gin's builders,
 * whose `toJSON()` is the new definition, so gin alone decides the wire form. Anything the editor doesn't edit (fns,
 * interfaces, intersections) is kept as it was and shown as code. Pure, so it is tested alone.
 */
import {
  AliasType, AnyType, BoolType, ColorType, DateType, DurationType, EnumType, Extension, isTypeName, ListType, LiteralType, MapType, NullableType, NullType,
  NumType, ObjType, OptionalType, OrType, TextType, TimestampType, TupleType, VoidType,
  type BoolOptions, type ColorOptions, type DateOptions, type ListOptions, type NumOptions, type Registry, type TextOptions, type TimestampOptions, type Type, type TypeDef,
} from '@aeye/gin';
import { humanize } from '@harness/core';

/** A field of an object type. */
export interface FieldShape {
  readonly name: string;
  readonly docs: string;
  /** May be left out (gin's `optional<T>` field). */
  readonly optional: boolean;
  readonly type: TypeShape;
}

/** One choice of an enum: its label and the value it stands for. */
export interface EnumValue {
  readonly label: string;
  readonly value: string | number;
}

/** A type as the editor holds it. Every node has its own docs. */
export type TypeShape =
  | { readonly kind: 'text'; readonly docs: string; readonly options: TextOptions }
  | { readonly kind: 'num'; readonly docs: string; readonly options: NumOptions }
  | { readonly kind: 'bool'; readonly docs: string; readonly options: BoolOptions }
  | { readonly kind: 'date'; readonly docs: string; readonly options: DateOptions }
  | { readonly kind: 'timestamp'; readonly docs: string; readonly options: TimestampOptions }
  | { readonly kind: 'color'; readonly docs: string; readonly options: ColorOptions }
  | { readonly kind: 'duration' | 'any' | 'void' | 'null'; readonly docs: string }
  | { readonly kind: 'list'; readonly docs: string; readonly item: TypeShape; readonly options: ListOptions }
  | { readonly kind: 'map'; readonly docs: string; readonly key: TypeShape; readonly value: TypeShape }
  | { readonly kind: 'tuple'; readonly docs: string; readonly elements: readonly TypeShape[] }
  | { readonly kind: 'obj'; readonly docs: string; readonly fields: readonly FieldShape[] }
  | { readonly kind: 'optional' | 'nullable'; readonly docs: string; readonly inner: TypeShape }
  | { readonly kind: 'or'; readonly docs: string; readonly variants: readonly TypeShape[] }
  | { readonly kind: 'enum'; readonly docs: string; readonly values: readonly EnumValue[] }
  | { readonly kind: 'literal'; readonly docs: string; readonly value: string | number | boolean }
  /** A use of a named type (`fs/Entry`). */
  | { readonly kind: 'ref'; readonly docs: string; readonly name: string }
  /** A named type's own definition: its name and the type it extends. Only at the root. */
  | { readonly kind: 'named'; readonly docs: string; readonly name: string; readonly base: TypeShape }
  /** Something the editor shows but doesn't edit (a fn, an interface, an intersection): kept as it was. */
  | { readonly kind: 'other'; readonly docs: string; readonly def: TypeDef; readonly code: string };

/** Every kind of shape. */
export type ShapeKind = TypeShape['kind'];

/** The kinds a person can choose for a node, in the order the kind picker lists them, with their labels. */
export const PICKABLE_KINDS = [
  { kind: 'text', label: 'Text' }, { kind: 'num', label: 'Number' }, { kind: 'bool', label: 'Yes or no' }, { kind: 'enum', label: 'One of' },
  { kind: 'date', label: 'Date' }, { kind: 'timestamp', label: 'Date and time' }, { kind: 'duration', label: 'Duration' }, { kind: 'color', label: 'Colour' },
  { kind: 'list', label: 'List' }, { kind: 'map', label: 'Map' }, { kind: 'tuple', label: 'Tuple' }, { kind: 'obj', label: 'Object' },
  { kind: 'optional', label: 'Optional' }, { kind: 'nullable', label: 'Nullable' }, { kind: 'or', label: 'Either' }, { kind: 'literal', label: 'Exactly' },
  { kind: 'ref', label: 'Named type' }, { kind: 'any', label: 'Any JSON' },
] as const satisfies readonly { readonly kind: Exclude<ShapeKind, 'named' | 'other' | 'void' | 'null'>; readonly label: string }[];

/** A kind a person can choose. */
export type PickableKind = (typeof PICKABLE_KINDS)[number]['kind'];

/** The label of a kind, for the kind badge. */
export function kindLabel(kind: ShapeKind): string {
  const picked = PICKABLE_KINDS.find((k) => k.kind === kind);
  if (picked !== undefined) { return picked.label; }
  return kind === 'named' ? 'Named type' : kind === 'other' ? 'Other' : humanize(kind);
}

/** Whether a built-in class name only narrows that class (`text{maxLength=40}`) rather than naming a type. */
function isClassName(type: Extension): boolean {
  return type.registry.typeClass(type.name) !== undefined;
}

/**
 * Read a live gin type into a shape. `root` is true for the type being edited itself, where a named type's own
 * definition reads as `named`; anywhere below, a named type is a `ref` to it.
 */
export function shapeOf(type: Type, root = true): TypeShape {
  const docs = type.docs ?? '';
  const sub = (inner: Type): TypeShape => shapeOf(inner, false);
  if (type instanceof AliasType) { return { kind: 'ref', docs, name: type.options.name }; }
  if (type instanceof Extension) {
    if (isClassName(type)) { return withDocs(sub(type.base), docs); }
    return root ? { kind: 'named', docs, name: type.name, base: sub(type.base) } : { kind: 'ref', docs, name: type.name };
  }
  if (type instanceof TextType) { return { kind: 'text', docs, options: { ...type.options } }; }
  if (type instanceof NumType) { return { kind: 'num', docs, options: { ...type.options } }; }
  if (type instanceof BoolType) { return { kind: 'bool', docs, options: { ...type.options } }; }
  if (type instanceof TimestampType) { return { kind: 'timestamp', docs, options: { ...type.options } }; }
  if (type instanceof DateType) { return { kind: 'date', docs, options: { ...type.options } }; }
  if (type instanceof ColorType) { return { kind: 'color', docs, options: { ...type.options } }; }
  if (type instanceof DurationType) { return { kind: 'duration', docs }; }
  if (type instanceof AnyType) { return { kind: 'any', docs }; }
  if (type instanceof VoidType) { return { kind: 'void', docs }; }
  if (type instanceof NullType) { return { kind: 'null', docs }; }
  if (type instanceof ListType) { return { kind: 'list', docs, item: sub(type.item), options: { ...type.options } }; }
  if (type instanceof MapType) { return { kind: 'map', docs, key: sub(type.key), value: sub(type.value) }; }
  if (type instanceof TupleType) { return { kind: 'tuple', docs, elements: type.elements.map(sub) }; }
  if (type instanceof ObjType) {
    const fields = Object.entries(type.fields).map(([name, prop]): FieldShape => {
      const optional = prop.type instanceof OptionalType;
      const inner = prop.type instanceof OptionalType ? prop.type.inner : prop.type;
      return { name, docs: prop.docs ?? '', optional, type: sub(inner) };
    });
    return { kind: 'obj', docs, fields };
  }
  if (type instanceof OptionalType) { return { kind: 'optional', docs, inner: sub(type.inner) }; }
  if (type instanceof NullableType) { return { kind: 'nullable', docs, inner: sub(type.inner) }; }
  if (type instanceof OrType) { return { kind: 'or', docs, variants: type.variants.map(sub) }; }
  if (type instanceof EnumType) {
    const values = Object.entries(type.options.values).flatMap(([label, value]): EnumValue[] => (typeof value === 'string' || typeof value === 'number' ? [{ label, value }] : []));
    return { kind: 'enum', docs, values };
  }
  if (type instanceof LiteralType) {
    const value: unknown = type.literal;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return { kind: 'literal', docs, value }; }
  }
  return { kind: 'other', docs, def: type.toJSON(), code: type.toCode(undefined, { includeComments: false }) };
}

/** A shape with the docs of the type wrapping it, when it has some. */
function withDocs(shape: TypeShape, docs: string): TypeShape {
  return docs === '' ? shape : { ...shape, docs };
}

/** The options with no key left undefined, so a built type's definition carries only what was set. */
function defined<T extends object>(options: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(options, key)) { continue; }
    const value: unknown = Reflect.get(options, key);
    if (value !== undefined && value !== '' && !Number.isNaN(value)) { Reflect.set(out, key, value); }
  }
  return out;
}

/** Build a shape into a live gin type with `registry`'s builders (the registry checks every option as it builds). */
export function buildShape(shape: TypeShape, registry: Registry): Type {
  const r = registry;
  const build = (s: TypeShape): Type => buildShape(s, r);
  switch (shape.kind) {
    case 'text': return r.text(defined(shape.options));
    case 'num': return r.num(defined(shape.options));
    case 'bool': return r.bool(defined(shape.options));
    case 'date': return r.date(defined(shape.options));
    case 'timestamp': return r.timestamp(defined(shape.options));
    case 'color': return r.color(defined(shape.options));
    case 'duration': return r.duration();
    case 'any': return r.any();
    case 'void': return r.void();
    case 'null': return r.null();
    case 'list': return r.list(build(shape.item), defined(shape.options));
    case 'map': return r.map(build(shape.key), build(shape.value));
    case 'tuple': return r.tuple(shape.elements.map(build));
    case 'obj': return r.obj(Object.fromEntries(shape.fields.map((field) => {
      const inner = build(field.type);
      return [field.name, r.field(field.optional ? r.optional(inner) : inner, field.docs === '' ? {} : { docs: field.docs })];
    })));
    case 'optional': return r.optional(build(shape.inner));
    case 'nullable': return r.nullable(build(shape.inner));
    case 'or': return r.or(shape.variants.map(build));
    case 'enum': {
      const numbers = shape.values.length > 0 && shape.values.every((v) => typeof v.value === 'number');
      return numbers
        ? r.enum(Object.fromEntries(shape.values.map((v) => [v.label, Number(v.value)])), r.num())
        : r.enum(Object.fromEntries(shape.values.map((v) => [v.label, String(v.value)])), r.text());
    }
    case 'literal': return r.literal(shape.value);
    case 'ref': return r.alias(shape.name);
    case 'named': return r.extend(build(shape.base), { name: shape.name, ...(shape.docs === '' ? {} : { docs: shape.docs }) });
    case 'other': return r.parse(shape.def);
  }
}

/** The definition a shape stands for: gin's own JSON of the built type, with the node's docs. */
export function defOf(shape: TypeShape, registry: Registry): TypeDef {
  const def = buildShape(shape, registry).toJSON();
  return shape.docs === '' || shape.kind === 'named' ? def : { ...def, docs: shape.docs };
}

/** A new shape of a kind: the smallest that type checks (an object with one text field, a list of text). */
export function blankShape(kind: PickableKind, docs = ''): TypeShape {
  const text: TypeShape = { kind: 'text', docs: '', options: {} };
  switch (kind) {
    case 'text': return { kind, docs, options: {} };
    case 'num': return { kind, docs, options: {} };
    case 'bool': return { kind, docs, options: {} };
    case 'date': return { kind, docs, options: {} };
    case 'timestamp': return { kind, docs, options: {} };
    case 'color': return { kind, docs, options: {} };
    case 'duration': case 'any': return { kind, docs };
    case 'list': return { kind, docs, item: text, options: {} };
    case 'map': return { kind, docs, key: text, value: text };
    case 'tuple': return { kind, docs, elements: [text, { kind: 'num', docs: '', options: {} }] };
    case 'obj': return { kind, docs, fields: [{ name: 'name', docs: '', optional: false, type: text }] };
    case 'optional': case 'nullable': return { kind, docs, inner: text };
    case 'or': return { kind, docs, variants: [text, { kind: 'num', docs: '', options: {} }] };
    case 'enum': return { kind, docs, values: [{ label: 'first', value: 'first' }, { label: 'second', value: 'second' }] };
    case 'literal': return { kind, docs, value: 'value' };
    case 'ref': return { kind, docs, name: 'Type' };
  }
}

/**
 * The shape as another kind, keeping what carries over: its docs, and the inner type when moving between the
 * wrappers (a list's item becomes an optional's inner, and back).
 */
export function changeKind(shape: TypeShape, kind: PickableKind): TypeShape {
  if (shape.kind === kind) { return shape; }
  const inner = innerOf(shape);
  const blank = blankShape(kind, shape.docs);
  if (inner === undefined) { return blank; }
  switch (blank.kind) {
    case 'list': return { ...blank, item: inner };
    case 'optional': case 'nullable': return { ...blank, inner };
    case 'map': return { ...blank, value: inner };
    case 'or': return { ...blank, variants: [inner, ...blank.variants.slice(1)] };
    case 'text': case 'num': case 'bool': case 'date': case 'timestamp': case 'color': case 'duration': case 'any': case 'void': case 'null':
    case 'tuple': case 'obj': case 'enum': case 'literal': case 'ref': case 'named': case 'other':
      return blank;
  }
}

/** The one type a wrapper holds (a list's item, an optional's inner, a map's value), if it is one. */
function innerOf(shape: TypeShape): TypeShape | undefined {
  switch (shape.kind) {
    case 'list': return shape.item;
    case 'optional': case 'nullable': return shape.inner;
    case 'map': return shape.value;
    case 'text': case 'num': case 'bool': case 'date': case 'timestamp': case 'color': case 'duration': case 'any': case 'void': case 'null':
    case 'tuple': case 'obj': case 'or': case 'enum': case 'literal': case 'ref': case 'named': case 'other':
      return undefined;
  }
}

/** A name for a new field that the object doesn't have yet (`field`, `field2`, …). */
export function freshName(taken: readonly string[], base = 'field'): string {
  const used = new Set(taken);
  if (!used.has(base)) { return base; }
  let n = 2;
  while (used.has(`${base}${n}`)) { n++; }
  return `${base}${n}`;
}

/** Field names gin accepts: an identifier. */
const FIELD_NAME = /^[A-Za-z_$][\w$]*$/;

/** One thing wrong with a shape, by where it is (`fields.path`, `item`; '' for the node itself). */
export interface ShapeProblem {
  readonly path: string;
  readonly message: string;
}

const at = (path: string, key: string | number): string => (path === '' ? String(key) : `${path}.${key}`);

/**
 * What is wrong with a shape before gin is asked: empty or repeated field names, a field name that isn't an
 * identifier, a reference that isn't a type name, an enum with no values or repeated labels, a lower bound above
 * its upper one. Gin's own check (`checkShape`) catches the rest.
 */
export function shapeProblems(shape: TypeShape, path = ''): ShapeProblem[] {
  const out: ShapeProblem[] = [];
  const range = (min: number | undefined, max: number | undefined, what: string): void => {
    if (min !== undefined && max !== undefined && min > max) { out.push({ path, message: `The smallest ${what} is above the largest.` }); }
  };
  switch (shape.kind) {
    case 'text': range(shape.options.minLength, shape.options.maxLength, 'length'); break;
    case 'num': range(shape.options.min, shape.options.max, 'value'); break;
    case 'list': range(shape.options.minLength, shape.options.maxLength, 'length'); out.push(...shapeProblems(shape.item, at(path, 'item'))); break;
    case 'map': out.push(...shapeProblems(shape.key, at(path, 'key')), ...shapeProblems(shape.value, at(path, 'value'))); break;
    case 'tuple': shape.elements.forEach((e, i) => { out.push(...shapeProblems(e, at(path, i))); }); break;
    case 'or': shape.variants.forEach((v, i) => { out.push(...shapeProblems(v, at(path, i))); }); break;
    case 'optional': case 'nullable': out.push(...shapeProblems(shape.inner, at(path, 'inner'))); break;
    case 'named':
      if (!isTypeName(shape.name)) { out.push({ path, message: 'A type name is letters, digits and _, optionally with a system (fs/Entry).' }); }
      out.push(...shapeProblems(shape.base, at(path, 'base')));
      break;
    case 'ref': if (!isTypeName(shape.name)) { out.push({ path, message: 'A type name is letters, digits and _, optionally with a system (fs/Entry).' }); } break;
    case 'enum': {
      if (shape.values.length === 0) { out.push({ path, message: 'Add at least one value.' }); }
      const labels = shape.values.map((v) => v.label);
      if (labels.some((label) => label.trim() === '')) { out.push({ path, message: 'Every value needs a label.' }); }
      if (new Set(labels).size !== labels.length) { out.push({ path, message: 'Two values have the same label.' }); }
      break;
    }
    case 'obj': {
      const seen = new Set<string>();
      for (const field of shape.fields) {
        const where = at(path, field.name);
        if (field.name === '') { out.push({ path, message: 'Every field needs a name.' }); } else if (!FIELD_NAME.test(field.name)) {
          out.push({ path: where, message: 'A field name is letters, digits and _, not starting with a digit.' });
        }
        if (seen.has(field.name)) { out.push({ path: where, message: `There are two fields named ${field.name}.` }); }
        seen.add(field.name);
        out.push(...shapeProblems(field.type, where));
      }
      break;
    }
    case 'bool': case 'date': case 'timestamp': case 'color': case 'duration': case 'any': case 'void': case 'null': case 'literal': case 'other':
      break;
  }
  return out;
}

/** A shape checked by gin: its definition, or what gin said is wrong with it. */
export type CheckedShape = { readonly ok: true; readonly def: TypeDef; readonly code: string } | { readonly ok: false; readonly problems: readonly ShapeProblem[] };

/**
 * Check a shape: the editor's own rules first, then gin builds it (which refuses bad options) and parses its
 * definition back, so what is saved is a definition gin reads.
 */
export function checkShape(shape: TypeShape, registry: Registry, parse: (def: TypeDef) => Type | undefined): CheckedShape {
  const problems = shapeProblems(shape);
  if (problems.length > 0) { return { ok: false, problems }; }
  try {
    const def = defOf(shape, registry);
    const parsed = parse(def);
    if (parsed === undefined) { return { ok: false, problems: [{ path: '', message: "gin can't read this type." }] }; }
    return { ok: true, def, code: parsed.toCode(undefined, { includeComments: false }) };
  } catch (error) {
    return { ok: false, problems: [{ path: '', message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** The constraints of a node in a few words, for the viewer: "1 to 40 characters", "whole, 0 or more". */
export function constraintText(shape: TypeShape): string {
  const range = (min: number | undefined, max: number | undefined, unit: string): string => {
    if (min !== undefined && max !== undefined) { return `${min} to ${max}${unit}`; }
    if (min !== undefined) { return `${min} or more${unit}`; }
    return max === undefined ? '' : `up to ${max}${unit}`;
  };
  switch (shape.kind) {
    case 'text': return [range(shape.options.minLength, shape.options.maxLength, ' characters'), shape.options.pattern === undefined ? '' : `matches /${shape.options.pattern}/${shape.options.flags ?? ''}`].filter((s) => s !== '').join(', ');
    case 'num': return [shape.options.whole === true ? 'whole' : '', range(shape.options.min, shape.options.max, '')].filter((s) => s !== '').join(', ');
    case 'list': return range(shape.options.minLength, shape.options.maxLength, ' items');
    case 'date': case 'timestamp': return [shape.options.min === undefined ? '' : `from ${shape.options.min}`, shape.options.max === undefined ? '' : `until ${shape.options.max}`].filter((s) => s !== '').join(' ');
    case 'color': return shape.options.hasAlpha === true ? 'with alpha' : '';
    case 'enum': return shape.values.map((v) => v.label).join(', ');
    case 'literal': return JSON.stringify(shape.value);
    case 'bool': case 'duration': case 'any': case 'void': case 'null': case 'map': case 'tuple': case 'obj': case 'optional': case 'nullable': case 'or': case 'ref': case 'named': case 'other':
      return '';
  }
}

/** A bound typed into an option's box: a number, or undefined when the box is empty or isn't a number. */
export function boundOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') { return undefined; }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Options with one option set, or left out when `value` is undefined (gin reads a missing option as unset). */
export function withOption<O extends object, K extends keyof O>(options: O, key: K, value: Exclude<O[K], undefined> | undefined): O {
  const next = { ...options };
  if (value === undefined) { Reflect.deleteProperty(next, key); } else { next[key] = value; }
  return next;
}

/** A bound as its box shows it ('' when unset). */
export function boundText(n: number | undefined): string {
  return n === undefined ? '' : String(n);
}

/** What a literal's value is, for the literal editor's switch. */
export type LiteralKind = 'text' | 'number' | 'bool';

/** The kind of a literal value. */
export function literalKind(value: string | number | boolean): LiteralKind {
  return typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'text';
}

/** A literal's value as another kind: `'3'` as a number is 3, anything as yes or no is true unless it is false or empty. */
export function literalAs(value: string | number | boolean, kind: LiteralKind): string | number | boolean {
  switch (kind) {
    case 'text': return String(value);
    case 'number': return boundOf(String(value)) ?? 0;
    case 'bool': return value !== false && value !== '' && value !== 'false' && value !== 0;
  }
}

/** Replace one item of a list. */
export function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  return items.map((existing, i) => (i === index ? item : existing));
}

/** Remove one item of a list. */
export function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

/** Move one item of a list by `by` places, kept inside the list. */
export function moveAt<T>(items: readonly T[], index: number, by: number): T[] {
  const next = [...items];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) { return next; }
  next.splice(Math.max(0, Math.min(next.length, index + by)), 0, moved);
  return next;
}
