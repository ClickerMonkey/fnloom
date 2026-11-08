/**
 * Forms from gin types. A fn's args, a handler's answer and a renderer's form arrive as gin type definitions (JSON);
 * the browser's type library parses one into a live gin `Type` (with the named types it holds bound), and `formOf`
 * reads that type into a `FormNode` tree by gin's own classes: text with its constraints, numbers, booleans, enums,
 * dates and timestamps, durations, colours, lists, maps, tuples, objects with optional fields and defaults,
 * nullables, unions, literals, named types and any JSON. gin is the only description of its type system here: every
 * option and generic is read through the typed class that owns it, so a change in gin breaks this file at compile
 * time. A named type the browser holds carries the form of its definition, so it is entered as that shape when no
 * system input is registered.
 *
 * A `Draft` holds what the person has typed so far for a node; `encode` reads a draft into the JSON value it stands
 * for, with a problem only where the typing can't be read (a number that isn't one). Whether the value fits its type
 * (lengths, ranges, patterns, wire forms) is gin's call: `issueProblems` turns gin's value-schema issues into a
 * problem per field.
 */
import {
  AliasType, AnyType, BoolType, ColorType, DateType, DurationType, EnumType, Extension, ListType, LiteralType, MapType, NewExpr, NullableType, NullType,
  NumType, ObjType, OptionalType, OrType, TextType, TimestampType, TupleType, VoidType, type Type,
} from '@aeye/gin';
import { humanize, Json } from '@harness/core';
import { z } from 'zod';

import { LOCAL_TYPES, type Issue, type TypeSource } from '../types.ts';

/** A choice of an enum: its label and the value it sends. */
export interface EnumChoice {
  readonly label: string;
  readonly value: string | number;
}

/** One field of an object form. */
export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly docs: string;
  readonly node: FormNode;
  /** May be left out. */
  readonly optional: boolean;
  /** The field's default, shown as a hint and used to start the draft. */
  readonly fallback?: Json;
}

/** The node kinds read straight off a gin class, with no options or generics. */
type ScalarKind = 'bool' | 'date' | 'timestamp' | 'duration' | 'color' | 'json';

/** A form for one gin type. */
export type FormNode =
  | { readonly kind: 'text'; readonly docs: string; readonly minLength?: number; readonly maxLength?: number; readonly pattern?: string; readonly flags?: string; readonly multiline: boolean }
  | { readonly kind: 'num'; readonly docs: string; readonly min?: number; readonly max?: number; readonly whole: boolean }
  | { readonly kind: ScalarKind; readonly docs: string }
  | { readonly kind: 'enum'; readonly docs: string; readonly choices: readonly EnumChoice[] }
  | { readonly kind: 'literal'; readonly docs: string; readonly value: Json }
  | { readonly kind: 'list'; readonly docs: string; readonly item: FormNode; readonly minLength?: number; readonly maxLength?: number }
  | { readonly kind: 'map'; readonly docs: string; readonly key: FormNode; readonly value: FormNode }
  | { readonly kind: 'tuple'; readonly docs: string; readonly elements: readonly FormNode[] }
  | { readonly kind: 'obj'; readonly docs: string; readonly fields: readonly FormField[] }
  | { readonly kind: 'nullable'; readonly docs: string; readonly inner: FormNode }
  | { readonly kind: 'or'; readonly docs: string; readonly options: readonly { readonly label: string; readonly node: FormNode }[] }
  /** `inner` is the form of the named type's definition, when the browser holds it (and it isn't recursive). */
  | { readonly kind: 'ref'; readonly docs: string; readonly name: string; readonly inner?: FormNode };

/** Every kind of form node. */
export type FormKind = FormNode['kind'];

/** gin's scalar classes and the kind each reads as. */
const SCALARS: ReadonlyArray<readonly [abstract new (...args: never[]) => Type, ScalarKind]> = [
  [BoolType, 'bool'], [DateType, 'date'], [TimestampType, 'timestamp'], [DurationType, 'duration'], [ColorType, 'color'],
  [AnyType, 'json'], [VoidType, 'json'], [NullType, 'json'],
];

const TEXTY_NAMES = /^(content|body|text|description|message|prompt|code|notes?)$/i;

/** Words in a named text type's docs that say it runs over many lines (the hub's `LongText`). */
const LONG_TEXT_DOCS = /many lines|text area/i;

/**
 * Read a gin type definition into a form, by parsing it with the browser's type library into a live gin type.
 * A definition gin can't parse becomes a JSON field (logged); a named type the library doesn't hold is a ref with
 * no inner form (entered with its system's input, or as JSON).
 */
export function formOf(def: unknown, field = '', types: TypeSource = LOCAL_TYPES): FormNode {
  const type = types.type(def);
  return type === undefined ? { kind: 'json', docs: '' } : nodeOf(type, field, new Set());
}

/** A form node for a live gin type. `within` holds the named types being read, so a recursive one stops at a ref. */
function nodeOf(type: Type, field: string, within: ReadonlySet<string>): FormNode {
  const docs = type.docs ?? '';
  const sub = (inner: Type, name: string): FormNode => nodeOf(inner, name, within);
  if (type instanceof AliasType) { return named(type.options.name, docs, field, type.simplify(), within); }
  if (type instanceof Extension) {
    // a narrowing of a built-in class (`text{maxLength=40}`) is that class; any other extension is a named type
    return isClassName(type) ? withDocs(sub(type.base, field), docs) : named(type.name, docs, field, type, within);
  }
  if (type instanceof TextType) {
    const { minLength, maxLength, pattern, flags } = type.options;
    return {
      kind: 'text', docs, multiline: TEXTY_NAMES.test(field) || (maxLength ?? 0) > 200,
      ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }),
      ...(pattern === undefined ? {} : { pattern }), ...(flags === undefined ? {} : { flags }),
    };
  }
  if (type instanceof NumType) {
    const { min, max, whole } = type.options;
    return { kind: 'num', docs, whole: whole === true, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
  if (type instanceof EnumType) {
    const choices = Object.entries(type.options.values).flatMap(([label, value]): EnumChoice[] => (
      typeof value === 'string' || typeof value === 'number' ? [{ label: humanize(label), value }] : []
    ));
    return { kind: 'enum', docs, choices };
  }
  if (type instanceof LiteralType) {
    const value = Json.safeParse(type.literal);
    return { kind: 'literal', docs, value: value.success ? value.data : null };
  }
  if (type instanceof ListType) {
    const { minLength, maxLength } = type.options;
    return { kind: 'list', docs, item: sub(type.item, field), ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }) };
  }
  if (type instanceof MapType) { return { kind: 'map', docs, key: sub(type.key, field), value: sub(type.value, field) }; }
  if (type instanceof TupleType) { return { kind: 'tuple', docs, elements: type.elements.map((element, i) => sub(element, `${field}${i}`)) }; }
  if (type instanceof ObjType) {
    const fields = Object.entries(type.fields).map(([name, prop]): FormField => {
      const optional = prop.type instanceof OptionalType;
      const inner = prop.type instanceof OptionalType ? prop.type.inner : prop.type;
      const fallback = prop.default instanceof NewExpr ? Json.safeParse(prop.default.value) : undefined;
      return {
        name, label: humanize(name), docs: prop.docs ?? prop.type.docs ?? inner.docs ?? '', optional, node: sub(inner, name),
        ...(fallback?.success === true ? { fallback: fallback.data } : {}),
      };
    });
    return { kind: 'obj', docs, fields };
  }
  if (type instanceof OptionalType || type instanceof NullableType) { return { kind: 'nullable', docs, inner: sub(type.inner, field) }; }
  if (type instanceof OrType) { return { kind: 'or', docs, options: type.variants.map((variant, i) => ({ label: optionLabel(variant, i), node: sub(variant, field) })) }; }
  const scalar = SCALARS.find(([cls]) => type instanceof cls)?.[1];
  // fns, interfaces, intersections and type values have no form of their own: they are entered as JSON
  return { kind: scalar ?? 'json', docs };
}

/** Whether an extension only narrows a built-in class, keeping its name (`text{maxLength=40}`), rather than naming a type. */
function isClassName(type: Extension): boolean {
  return type.registry.typeClass(type.name) !== undefined;
}

/** A node with the docs of the type that wraps it, when it has some. */
function withDocs(node: FormNode, docs: string): FormNode {
  return docs === '' ? node : { ...node, docs };
}

/**
 * A named type: a ref, with the form of its definition when the library resolved it (`target` isn't the unresolved
 * alias itself) and it isn't one it is already inside.
 */
function named(name: string, docs: string, field: string, target: Type, within: ReadonlySet<string>): FormNode {
  if (within.has(name) || target instanceof AliasType) { return { kind: 'ref', docs, name }; }
  // the named type's own definition is an extension of the type it `extends`: its form is that type's, narrowed
  const definition = target instanceof Extension && target.name === name ? target : undefined;
  const inner = nodeOf(definition === undefined ? target : definition.base, field, new Set([...within, name]));
  const ownDocs = definition?.docs ?? target.docs ?? '';
  const shaped = inner.kind === 'text' && LONG_TEXT_DOCS.test(ownDocs) ? { ...inner, multiline: true } : inner;
  return { kind: 'ref', docs: docs === '' ? (ownDocs === '' ? shaped.docs : ownDocs) : docs, name, inner: shaped };
}

/** A union option's label, by what it is. */
function optionLabel(type: Type, i: number): string {
  if (type instanceof TextType) { return 'Text'; }
  if (type instanceof NumType) { return 'Number'; }
  if (type instanceof BoolType) { return 'Yes or no'; }
  if (type instanceof ListType) { return 'List'; }
  if (type instanceof ObjType) {
    const names = Object.keys(type.fields);
    return names.length > 0 ? `With ${names.slice(0, 2).map(humanize).join(', ').toLowerCase()}` : `Option ${i + 1}`;
  }
  return humanize(type instanceof AliasType ? type.options.name : type.name);
}

/** What has been typed so far for one node. */
export type Draft =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'items'; readonly items: readonly Draft[] }
  | { readonly kind: 'entries'; readonly entries: readonly { readonly key: Draft; readonly value: Draft }[] }
  | { readonly kind: 'fields'; readonly fields: Readonly<Record<string, Draft>>; readonly present: Readonly<Record<string, boolean>> }
  | { readonly kind: 'or'; readonly option: number; readonly value: Draft }
  | { readonly kind: 'nullable'; readonly isNull: boolean; readonly value: Draft }
  | { readonly kind: 'value'; readonly value: Json | undefined };

const pad = (n: number): string => String(n).padStart(2, '0');

/** A timestamp as `datetime-local` text, in the reader's zone. */
function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) { return ''; }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A packed rgb colour as `#rrggbb`. */
export const hex = (color: number): string => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;

/** One entry of a map value: gin's logical JSON writes a map as `[{ key, value }]`. */
const MapPair = z.object({ key: Json, value: Json });

/** A map value's entries; entries that aren't `{ key, value }` (or a value that isn't a list) are left out. */
export function mapPairs(value: Json | undefined): { readonly key: Json; readonly value: Json }[] {
  return Array.isArray(value) ? value.flatMap((pair) => {
    const parsed = MapPair.safeParse(pair);
    return parsed.success ? [parsed.data] : [];
  }) : [];
}

/** A draft for a node, from a value it should start with (a default, or a value being edited). */
export function draftOf(node: FormNode, value?: Json): Draft {
  switch (node.kind) {
    case 'text': return { kind: 'text', text: typeof value === 'string' ? value : '' };
    case 'num': return { kind: 'text', text: typeof value === 'number' ? String(value) : '' };
    case 'duration': return { kind: 'text', text: typeof value === 'number' ? String(value) : '' };
    case 'date': return { kind: 'text', text: typeof value === 'string' ? value.slice(0, 10) : '' };
    case 'timestamp': return { kind: 'text', text: typeof value === 'string' ? localDateTime(value) : '' };
    case 'color': return { kind: 'text', text: typeof value === 'number' ? hex(value) : '#000000' };
    case 'json': return { kind: 'text', text: value === undefined ? '' : JSON.stringify(value, null, 2) };
    case 'bool': return { kind: 'bool', value: value === true };
    case 'enum': return { kind: 'choice', index: node.choices.findIndex((c) => c.value === value) };
    case 'literal': return { kind: 'value', value: node.value };
    case 'ref': return node.inner === undefined ? { kind: 'value', value } : draftOf(node.inner, value);
    case 'list': return { kind: 'items', items: Array.isArray(value) ? value.map((v) => draftOf(node.item, v)) : [] };
    case 'tuple': return { kind: 'items', items: node.elements.map((e, i) => draftOf(e, Array.isArray(value) ? value[i] : undefined)) };
    case 'map': return { kind: 'entries', entries: mapPairs(value).map((pair) => ({ key: draftOf(node.key, pair.key), value: draftOf(node.value, pair.value) })) };
    case 'obj': {
      const given = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const fields: Record<string, Draft> = {};
      const present: Record<string, boolean> = {};
      for (const field of node.fields) {
        const start = given[field.name] ?? field.fallback;
        fields[field.name] = draftOf(field.node, start);
        present[field.name] = !field.optional || start !== undefined;
      }
      return { kind: 'fields', fields, present };
    }
    case 'nullable': return { kind: 'nullable', isNull: value === null || value === undefined, value: draftOf(node.inner, value ?? undefined) };
    case 'or': {
      const at = Math.max(0, node.options.findIndex((o) => fits(o.node, value)));
      const option = node.options[at];
      return { kind: 'or', option: at, value: option === undefined ? { kind: 'value', value } : draftOf(option.node, value) };
    }
  }
}

/** A rough check of which union option a value belongs to: starts a draft on the right option and picks the option a viewer draws. */
export function fits(node: FormNode, value: Json | undefined): boolean {
  if (value === undefined) { return false; }
  switch (node.kind) {
    case 'text': case 'date': case 'timestamp': return typeof value === 'string';
    case 'num': case 'duration': case 'color': return typeof value === 'number';
    case 'bool': return typeof value === 'boolean';
    case 'list': case 'tuple': case 'map': return Array.isArray(value);
    case 'obj': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'enum': return node.choices.some((c) => c.value === value);
    case 'literal': return node.value === value;
    case 'ref': return node.inner === undefined || fits(node.inner, value);
    case 'json': case 'nullable': case 'or': return true;
  }
}

/** A problem with one field, by its path (`files.0.path`; '' for the whole value). */
export interface FormProblem {
  readonly path: string;
  readonly message: string;
}

/** A draft checked: the JSON to send, or the problems that stop it. */
export type Encoded = { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly problems: readonly FormProblem[] };

const join = (path: string, key: string | number): string => (path === '' ? String(key) : `${path}.${key}`);

/** Parse a duration: ms as a number, or with a unit (`1.5s`, `2m`, `1h`). */
export function parseDuration(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(text);
  if (match === null) { return undefined; }
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const key = match[2] ?? 'ms';
  const factor = key === 's' ? unit.s : key === 'm' ? unit.m : key === 'h' ? unit.h : unit.ms;
  return Math.round(Number(match[1]) * factor);
}

/** Read a draft into the JSON it stands for, with a problem where the typing can't be read. gin checks the rest. */
export function encode(node: FormNode, draft: Draft, path = ''): Encoded {
  const problems: FormProblem[] = [];
  const value = walk(node, draft, path, problems);
  return problems.length > 0 || value === undefined ? { ok: false, problems: problems.length > 0 ? problems : [{ path, message: 'Required.' }] } : { ok: true, value };
}

function walk(node: FormNode, draft: Draft, path: string, problems: FormProblem[]): Json | undefined {
  const fail = (message: string): Json | undefined => { problems.push({ path, message }); return undefined; };
  switch (node.kind) {
    case 'text': return draft.kind === 'text' ? draft.text : '';
    case 'num': {
      const text = draft.kind === 'text' ? draft.text.trim() : '';
      if (text === '') { return fail('Required.'); }
      const n = Number(text);
      return Number.isFinite(n) ? n : fail('Enter a number.');
    }
    case 'bool': return draft.kind === 'bool' ? draft.value : false;
    case 'date': {
      const text = draft.kind === 'text' ? draft.text : '';
      return text === '' ? fail('Pick a date.') : text;
    }
    case 'timestamp': {
      const text = draft.kind === 'text' ? draft.text : '';
      const date = new Date(text);
      return text === '' || Number.isNaN(date.getTime()) ? fail('Pick a date and time.') : date.toISOString();
    }
    case 'duration': {
      const ms = parseDuration(draft.kind === 'text' ? draft.text : '');
      return ms === undefined ? fail('Enter a duration, like 500ms, 2s or 5m.') : ms;
    }
    case 'color': {
      const text = draft.kind === 'text' ? draft.text : '';
      return /^#[0-9a-f]{6}$/i.test(text) ? Number.parseInt(text.slice(1), 16) : fail('Pick a colour.');
    }
    case 'json': {
      const text = draft.kind === 'text' ? draft.text.trim() : '';
      if (text === '') { return null; }
      try {
        const parsed = Json.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : fail('Enter JSON.');
      } catch {
        return fail('Enter valid JSON.');
      }
    }
    case 'enum': {
      const choice = draft.kind === 'choice' ? node.choices[draft.index] : undefined;
      return choice === undefined ? fail('Choose one.') : choice.value;
    }
    case 'literal': return node.value;
    case 'ref': {
      // a system's input sets the value itself; otherwise the definition's own form was typed into
      if (draft.kind === 'value') { return draft.value !== undefined ? draft.value : fail('Required.'); }
      return node.inner === undefined ? fail('Required.') : walk(node.inner, draft, path, problems);
    }
    case 'list': {
      const items = draft.kind === 'items' ? draft.items : [];
      const out = items.map((item, i) => walk(node.item, item, join(path, i), problems));
      return present(out);
    }
    case 'tuple': {
      const items = draft.kind === 'items' ? draft.items : [];
      const out = node.elements.map((element, i) => {
        const item = items[i];
        return item === undefined ? undefined : walk(element, item, join(path, i), problems);
      });
      return present(out);
    }
    case 'map': {
      const entries = draft.kind === 'entries' ? draft.entries : [];
      const out = entries.map((entry, i) => {
        const key = walk(node.key, entry.key, join(join(path, i), 'key'), problems);
        const value = walk(node.value, entry.value, join(join(path, i), 'value'), problems);
        return key === undefined || value === undefined ? undefined : { key, value };
      });
      return present(out);
    }
    case 'obj': {
      if (draft.kind !== 'fields') { return fail('Required.'); }
      const out: Record<string, Json> = {};
      let complete = true;
      for (const field of node.fields) {
        if (field.optional && draft.present[field.name] !== true) { continue; }
        const inner = draft.fields[field.name] ?? draftOf(field.node);
        const value = walk(field.node, inner, join(path, field.name), problems);
        if (value === undefined) { complete = false; } else { out[field.name] = value; }
      }
      return complete ? out : undefined;
    }
    case 'nullable': {
      if (draft.kind !== 'nullable' || draft.isNull) { return null; }
      return walk(node.inner, draft.value, path, problems);
    }
    case 'or': {
      const option = draft.kind === 'or' ? node.options[draft.option] : undefined;
      if (option === undefined || draft.kind !== 'or') { return fail('Choose one.'); }
      return walk(option.node, draft.value, path, problems);
    }
  }
}

/** All the values, or undefined when any is missing. */
function present(values: readonly (Json | undefined)[]): Json[] | undefined {
  const out: Json[] = [];
  for (const value of values) {
    if (value === undefined) { return undefined; }
    out.push(value);
  }
  return out;
}

/** The problem for a path, if any. */
export function problemAt(problems: readonly FormProblem[], path: string): string {
  return problems.find((p) => p.path === path)?.message ?? '';
}

const count = (n: number | bigint | undefined): string => (n === undefined ? '' : String(n));

/** One gin issue in plain words, by what it is about: "Required.", "At most 10 characters.", "Enter a whole number.". */
export function issueText(issue: Issue): string {
  const { code, origin } = issue;
  if (code === 'too_small') {
    if (origin === 'string') { return issue.minimum !== undefined && Number(issue.minimum) <= 1 ? 'Required.' : `At least ${count(issue.minimum)} characters.`; }
    if (origin === 'array' || origin === 'set') { return `Add at least ${count(issue.minimum)}.`; }
    return `At least ${count(issue.minimum)}.`;
  }
  if (code === 'too_big') { return origin === 'string' ? `At most ${count(issue.maximum)} characters.` : `At most ${count(issue.maximum)}.`; }
  if (code === 'invalid_format') { return 'Check the format.'; }
  if ((code === 'invalid_type' && issue.expected === 'int') || code === 'not_multiple_of') { return 'Enter a whole number.'; }
  const message = issue.message.trim();
  if (message === '') { return 'This value does not fit.'; }
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}${/[.!?]$/.test(message) ? '' : '.'}`;
}

/** gin's issues as form problems, each at its field's path (`files.0.path`; '' for the value as a whole). */
export function issueProblems(issues: readonly Issue[]): FormProblem[] {
  return issues.map((issue) => ({ path: issue.path.flatMap((key) => (typeof key === 'symbol' ? [] : [String(key)])).join('.'), message: issueText(issue) }));
}

/** A hint line for a node from its constraints: "1 to 10, whole numbers", "Up to 200 characters". */
export function constraintHint(node: FormNode): string {
  switch (node.kind) {
    case 'text': return [node.minLength !== undefined && node.minLength > 1 ? `at least ${node.minLength}` : '', node.maxLength !== undefined ? `up to ${node.maxLength}` : '']
      .filter((s) => s !== '').join(', ').replace(/^./, (c) => c.toUpperCase()) + (node.minLength !== undefined && node.minLength > 1 || node.maxLength !== undefined ? ' characters' : '');
    case 'num': {
      const range = node.min !== undefined && node.max !== undefined ? `${node.min} to ${node.max}` : node.min !== undefined ? `${node.min} or more` : node.max !== undefined ? `Up to ${node.max}` : '';
      return [range, node.whole ? 'whole numbers' : ''].filter((s) => s !== '').join(', ').replace(/^./, (c) => c.toUpperCase());
    }
    case 'duration': return 'Like 500ms, 2s, 5m or 1h';
    case 'list': return node.maxLength !== undefined ? `Up to ${node.maxLength}` : '';
    case 'bool': case 'color': case 'date': case 'timestamp': case 'enum': case 'literal': case 'json':
    case 'map': case 'nullable': case 'obj': case 'or': case 'ref': case 'tuple':
      return '';
  }
}
