/**
 * Forms from gin types. A fn's args, a handler's answer and a renderer's form arrive as gin type definitions (JSON);
 * `formOf` reads one into a `FormNode` tree with a node for every gin type (text with its constraints, numbers,
 * booleans, enums, dates and timestamps, durations, colours, lists, maps, tuples, objects with optional fields,
 * nullables, unions, literals, refs to named types, and any JSON). A `Draft` holds what the person has typed so far
 * for a node; `encode` checks a draft and turns it into the JSON the hub expects, with a problem per field. gin
 * itself makes the final check (`ginCheck`) where the type can be rebuilt in the browser.
 *
 * Wire forms follow gin: dates `YYYY-MM-DD`, timestamps ISO strings, durations ms, colours packed ints, maps
 * `[{ key, value }]`.
 */
import type {
  EnumOptions as GinEnumOptions, ListOptions as GinListOptions, NewExprDef, NumOptions as GinNumOptions, PropDef, TextOptions as GinTextOptions, TypeDef,
} from '@aeye/gin';
import { isGinTypeDef, Json } from '@harness/core';
import { g } from '@harness/sdk';
import { z } from 'zod';
import { humanize } from '../logic/labels.ts';

/** Every key of `T` also accepts `undefined`, as zod's output for an optional field does. */
type Loose<T> = { [K in keyof T]: T[K] | undefined };

/**
 * A field default as gin writes it: a `new` expression carrying the value. Other expressions (computed defaults) need
 * gin's engine, so the form starts those fields empty.
 */
const NewDefault = z.object({ kind: z.literal('new'), value: Json }) satisfies z.ZodType<Pick<NewExprDef, 'kind' | 'value'>>;

/**
 * The part of a gin type definition a form reads. Its keys are picked from gin's `TypeDef` and `PropDef`, so a rename
 * in gin breaks here. gin's own `parse` is the full check.
 */
interface DefShape extends Loose<Pick<TypeDef<Record<string, unknown>>, 'docs' | 'options'>> {
  name: TypeDef['name'];
  generic?: Record<string, DefShape> | undefined;
  props?: Record<string, PropShape> | undefined;
}
/** A prop of an object type; `default` is gin's default expression (see `NewDefault`). */
interface PropShape extends Loose<Pick<PropDef, 'docs'>> {
  type: DefShape;
  /** gin's default expression, read through `NewDefault`. */
  default?: unknown;
}

const Def: z.ZodType<DefShape> = z.lazy(() => z.object({
  name: z.string(),
  docs: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  generic: z.record(z.string(), Def).optional(),
  props: z.record(z.string(), z.object({ type: Def, docs: z.string().optional(), default: z.unknown().optional() })).optional(),
}));

/** The options of gin's text, num, list and enum types that a form uses, each pinned to gin's own options type. */
const TextOptions = z.object({ minLength: z.number().optional(), maxLength: z.number().optional(), pattern: z.string().optional(), flags: z.string().optional() }) satisfies z.ZodType<Loose<GinTextOptions>>;
const NumOptions = z.object({ min: z.number().optional(), max: z.number().optional(), whole: z.boolean().optional() }) satisfies z.ZodType<Loose<Pick<GinNumOptions, 'min' | 'max' | 'whole'>>>;
const ListOptions = z.object({ minLength: z.number().optional(), maxLength: z.number().optional() }) satisfies z.ZodType<Loose<GinListOptions>>;
const EnumOptions = z.object({ values: z.record(z.string(), z.union([z.string(), z.number()])) }) satisfies z.ZodType<GinEnumOptions<string | number>>;

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

/** A form for one gin type. */
export type FormNode =
  | { readonly kind: 'text'; readonly docs: string; readonly minLength?: number; readonly maxLength?: number; readonly pattern?: string; readonly flags?: string; readonly multiline: boolean }
  | { readonly kind: 'num'; readonly docs: string; readonly min?: number; readonly max?: number; readonly whole: boolean }
  | { readonly kind: 'bool' | 'date' | 'timestamp' | 'duration' | 'color' | 'json'; readonly docs: string }
  | { readonly kind: 'enum'; readonly docs: string; readonly choices: readonly EnumChoice[] }
  | { readonly kind: 'literal'; readonly docs: string; readonly value: Json }
  | { readonly kind: 'list'; readonly docs: string; readonly item: FormNode; readonly minLength?: number; readonly maxLength?: number }
  | { readonly kind: 'map'; readonly docs: string; readonly key: FormNode; readonly value: FormNode }
  | { readonly kind: 'tuple'; readonly docs: string; readonly elements: readonly FormNode[] }
  | { readonly kind: 'obj'; readonly docs: string; readonly fields: readonly FormField[] }
  | { readonly kind: 'nullable'; readonly docs: string; readonly inner: FormNode }
  | { readonly kind: 'or'; readonly docs: string; readonly options: readonly { readonly label: string; readonly node: FormNode }[] }
  | { readonly kind: 'ref'; readonly docs: string; readonly name: string };

/** Every kind of form node. */
export type FormKind = FormNode['kind'];

/** The gin class names a form knows, and the kind each reads as. Any other name is a ref to a named type. */
const SCALARS = { bool: 'bool', date: 'date', timestamp: 'timestamp', duration: 'duration', color: 'color', any: 'json', void: 'json', null: 'json' } as const;

const TEXTY_NAMES = /^(content|body|text|description|message|prompt|code|notes?)$/i;

/** Read a gin type definition into a form. Anything unreadable becomes a JSON field rather than failing. */
export function formOf(def: unknown, field = ''): FormNode {
  const parsed = Def.safeParse(def);
  if (!parsed.success) { return { kind: 'json', docs: '' }; }
  return nodeOf(parsed.data, field);
}

function nodeOf(def: DefShape, field: string): FormNode {
  const docs = def.docs ?? '';
  const generic = (key: string): FormNode => {
    const inner = def.generic?.[key];
    return inner === undefined ? { kind: 'json', docs: '' } : nodeOf(inner, field);
  };
  switch (def.name) {
    case 'text': {
      const o = TextOptions.safeParse(def.options ?? {});
      const opts = o.success ? o.data : {};
      return {
        kind: 'text', docs, multiline: TEXTY_NAMES.test(field) || (opts.maxLength ?? 0) > 200,
        ...(opts.minLength === undefined ? {} : { minLength: opts.minLength }), ...(opts.maxLength === undefined ? {} : { maxLength: opts.maxLength }),
        ...(opts.pattern === undefined ? {} : { pattern: opts.pattern }), ...(opts.flags === undefined ? {} : { flags: opts.flags }),
      };
    }
    case 'num': {
      const o = NumOptions.safeParse(def.options ?? {});
      const opts = o.success ? o.data : {};
      return { kind: 'num', docs, whole: opts.whole === true, ...(opts.min === undefined ? {} : { min: opts.min }), ...(opts.max === undefined ? {} : { max: opts.max }) };
    }
    case 'enum': {
      const o = EnumOptions.safeParse(def.options ?? {});
      const choices = o.success ? Object.entries(o.data.values).map(([label, value]) => ({ label: humanize(label), value })) : [];
      return { kind: 'enum', docs, choices };
    }
    case 'literal': {
      const value = Json.safeParse(def.options?.['value']);
      return { kind: 'literal', docs, value: value.success ? value.data : null };
    }
    case 'list': {
      const o = ListOptions.safeParse(def.options ?? {});
      const opts = o.success ? o.data : {};
      return { kind: 'list', docs, item: generic('V'), ...(opts.minLength === undefined ? {} : { minLength: opts.minLength }), ...(opts.maxLength === undefined ? {} : { maxLength: opts.maxLength }) };
    }
    case 'map': return { kind: 'map', docs, key: generic('K'), value: generic('V') };
    case 'tuple': {
      const elements = z.array(Def).safeParse(def.options?.['elements']);
      return { kind: 'tuple', docs, elements: elements.success ? elements.data.map((e, i) => nodeOf(e, `${field}${i}`)) : [] };
    }
    case 'obj': {
      const fields = Object.entries(def.props ?? {}).map(([name, prop]): FormField => {
        const optional = prop.type.name === 'optional';
        const inner = optional ? prop.type.generic?.['T'] : prop.type;
        const fallback = NewDefault.safeParse(prop.default);
        return {
          name, label: humanize(name), docs: prop.docs ?? prop.type.docs ?? '', optional,
          node: inner === undefined ? { kind: 'json', docs: '' } : nodeOf(inner, name),
          ...(fallback.success ? { fallback: fallback.data.value } : {}),
        };
      });
      return { kind: 'obj', docs, fields };
    }
    case 'optional': case 'nullable': return { kind: 'nullable', docs, inner: generic('T') };
    case 'or': {
      const types = z.array(Def).safeParse(def.options?.['types']);
      const options = types.success ? types.data.map((t, i) => ({ label: optionLabel(t, i), node: nodeOf(t, field) })) : [];
      return { kind: 'or', docs, options };
    }
    default: {
      const scalar = Object.entries(SCALARS).find(([name]) => name === def.name)?.[1];
      return scalar === undefined ? { kind: 'ref', docs, name: def.name } : { kind: scalar, docs };
    }
  }
}

function optionLabel(def: DefShape, i: number): string {
  switch (def.name) {
    case 'text': return 'Text';
    case 'num': return 'Number';
    case 'bool': return 'Yes or no';
    case 'obj': return Object.keys(def.props ?? {}).length > 0 ? `With ${Object.keys(def.props ?? {}).slice(0, 2).map(humanize).join(', ').toLowerCase()}` : `Option ${i + 1}`;
    case 'list': return 'List';
    default: return humanize(def.name);
  }
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

const hex = (color: number): string => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;

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
    case 'ref': return { kind: 'value', value };
    case 'list': return { kind: 'items', items: Array.isArray(value) ? value.map((v) => draftOf(node.item, v)) : [] };
    case 'tuple': return { kind: 'items', items: node.elements.map((e, i) => draftOf(e, Array.isArray(value) ? value[i] : undefined)) };
    case 'map': {
      const pairs = Array.isArray(value) ? value.flatMap((pair) => {
        const parsed = z.object({ key: Json, value: Json }).safeParse(pair);
        return parsed.success ? [parsed.data] : [];
      }) : [];
      return { kind: 'entries', entries: pairs.map((pair) => ({ key: draftOf(node.key, pair.key), value: draftOf(node.value, pair.value) })) };
    }
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

/** A rough check of which union option a value belongs to, to start a draft on the right one. */
function fits(node: FormNode, value: Json | undefined): boolean {
  if (value === undefined) { return false; }
  switch (node.kind) {
    case 'text': case 'date': case 'timestamp': return typeof value === 'string';
    case 'num': case 'duration': case 'color': return typeof value === 'number';
    case 'bool': return typeof value === 'boolean';
    case 'list': case 'tuple': case 'map': return Array.isArray(value);
    case 'obj': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'enum': return node.choices.some((c) => c.value === value);
    case 'literal': return node.value === value;
    default: return true;
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

/** Check a draft against its node and make its JSON. */
export function encode(node: FormNode, draft: Draft, path = ''): Encoded {
  const problems: FormProblem[] = [];
  const value = walk(node, draft, path, problems);
  return problems.length > 0 || value === undefined ? { ok: false, problems: problems.length > 0 ? problems : [{ path, message: 'Required.' }] } : { ok: true, value };
}

function walk(node: FormNode, draft: Draft, path: string, problems: FormProblem[]): Json | undefined {
  const fail = (message: string): Json | undefined => { problems.push({ path, message }); return undefined; };
  switch (node.kind) {
    case 'text': {
      const text = draft.kind === 'text' ? draft.text : '';
      if (node.minLength !== undefined && text.length < node.minLength) { return fail(node.minLength <= 1 ? 'Required.' : `At least ${node.minLength} characters.`); }
      if (node.maxLength !== undefined && text.length > node.maxLength) { return fail(`At most ${node.maxLength} characters.`); }
      if (node.pattern !== undefined && !safeRegex(node.pattern, node.flags).test(text)) { return fail('Check the format.'); }
      return text;
    }
    case 'num': {
      const text = draft.kind === 'text' ? draft.text.trim() : '';
      if (text === '') { return fail('Required.'); }
      const n = Number(text);
      if (!Number.isFinite(n)) { return fail('Enter a number.'); }
      if (node.whole && !Number.isInteger(n)) { return fail('Enter a whole number.'); }
      if (node.min !== undefined && n < node.min) { return fail(`At least ${node.min}.`); }
      if (node.max !== undefined && n > node.max) { return fail(`At most ${node.max}.`); }
      return n;
    }
    case 'bool': return draft.kind === 'bool' ? draft.value : false;
    case 'date': {
      const text = draft.kind === 'text' ? draft.text : '';
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fail('Pick a date.');
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
    case 'ref': return draft.kind === 'value' && draft.value !== undefined ? draft.value : fail('Required.');
    case 'list': {
      const items = draft.kind === 'items' ? draft.items : [];
      if (node.minLength !== undefined && items.length < node.minLength) { problems.push({ path, message: `Add at least ${node.minLength}.` }); }
      if (node.maxLength !== undefined && items.length > node.maxLength) { problems.push({ path, message: `At most ${node.maxLength}.` }); }
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

function safeRegex(pattern: string, flags: string | undefined): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return /[\s\S]*/;
  }
}

/** The problem for a path, if any. */
export function problemAt(problems: readonly FormProblem[], path: string): string {
  return problems.find((p) => p.path === path)?.message ?? '';
}

/**
 * gin's own check of a value against the type definition, where the type can be rebuilt here (a type naming a
 * system's own types needs that system's contract). Returns a problem, `''` when it fits, or undefined when it
 * couldn't check.
 */
export function ginCheck(def: unknown, value: Json): string | undefined {
  if (!isGinTypeDef(def)) { return undefined; }
  let type: ReturnType<typeof g.parse>;
  try {
    type = g.parse(def);
  } catch {
    return undefined;
  }
  try {
    type.parse(value);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : 'This value does not fit.';
  }
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
    default: return '';
  }
}
