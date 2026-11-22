/**
 * The one name the model sees for a fn (plan `injected-context-2026-11-22`, section 1). A fn's **model name** is its
 * qualified name with every `/` and `.` written `__` (`database/main.expenses_create` → `database__main__expenses_create`),
 * a valid tool name for every provider; past 64 characters it is cut to 54 and ended with `_x` and 8 hex of the
 * qualified name's sha-256. Only fns have model names: context keys, types and hook tags keep their own forms.
 *
 * This module owns the encoder, the rule a fn's local name keeps so its model name reads back (`FnLocalName`), the
 * registry's interface (`ModelFnNameIndex`, the hub's is built from its catalog and its history table), and the one
 * conversion every boundary uses (`modelFnNames`): text and values out to the model, names and values back in. Nothing
 * else spells a model name.
 */
import { z } from 'zod';
import type { GinTypeDef } from './gin.ts';
import { type Json, QualifiedName, SYSTEM_NAME_PATTERN, splitName, Timestamp } from './primitives.ts';

/** The longest tool name the strictest providers (OpenAI, Anthropic, Bedrock) take. */
export const MODEL_FN_NAME_MAX = 64;
/** Where a name too long is cut, before `_x` and its hash. */
export const MODEL_FN_NAME_CUT = 54;
/** How many hex characters of the sha-256 end a cut name. */
export const MODEL_FN_NAME_HASH = 8;

/** The one name the model sees for a fn: letters, digits, `_` and `-`, at most 64, starting with its system's first letter. */
export const ModelFnName = z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/).brand<'ModelFnName'>();
export type ModelFnName = z.infer<typeof ModelFnName>;

/** One dot-separated part of a fn's local name: starts with a letter or digit, never holds `__`, never ends with `_`. */
const FN_PART = '[A-Za-z0-9](?:[A-Za-z0-9-]|_(?![_.]|$))*';
/** The shape of a fn's local name whose model name reads back (`FnLocalName`). */
export const FN_LOCAL_NAME_PATTERN = new RegExp(`^${FN_PART}(?:\\.${FN_PART})*$`);

/**
 * A fn's local name the model name can carry: dot-separated parts, none holding `__` or starting or ending with `_`, so
 * `__` always separates parts and `a._b` can't be confused with `a_.b`. Context keys and types keep `LocalName`.
 */
export const FnLocalName = z.string().regex(FN_LOCAL_NAME_PATTERN, 'a fn name is letters, digits, `_` and `-` in dot-separated parts, each starting with a letter or digit, with no `__` and no part ending in `_`');

/** What is wrong with a fn's local name for its model name, in the hub's words; undefined when nothing is. */
export function fnLocalNameProblem(local: string): string | undefined {
  if (FN_LOCAL_NAME_PATTERN.test(local)) return undefined;
  if (local.includes('__')) return `${local} holds \`__\`, which separates the parts of the name the model calls it by: write one \`_\``;
  if (/(?:^|\.)_|_(?:\.|$)/.test(local)) return `a part of ${local} starts or ends with \`_\`: start each part with a letter or digit and end it with no \`_\``;
  return `${local} is not a fn name: letters, digits, \`_\` and \`-\` in dot-separated parts, each starting with a letter or digit`;
}

/** The name before any cut: system, then each part of the local name, `__` between them. */
function fullModelName(fn: QualifiedName): string {
  const { system, local } = splitName(fn);
  return `${system}__${local.replaceAll('.', '__')}`;
}

/** Model names already worked out: the same fn is encoded on every prompt. */
const encoded = new Map<string, ModelFnName>();
/** The most names `encoded` keeps before it starts over. */
const ENCODED_MAX = 20_000;

/** `/` and `.` as `__`; past 64 characters, cut to 54 (no trailing `_`) and ended with `_x` and 8 hex of the name's sha-256. */
export function modelFnName(fn: QualifiedName): ModelFnName {
  const known = encoded.get(fn);
  if (known !== undefined) return known;
  const full = fullModelName(fn);
  const name = full.length <= MODEL_FN_NAME_MAX
    ? full
    : `${full.slice(0, MODEL_FN_NAME_CUT).replace(/_+$/, '')}_x${sha256Hex(fn).slice(0, MODEL_FN_NAME_HASH)}`;
  const parsed = ModelFnName.parse(name.replace(/[^A-Za-z0-9_-]/g, '_'));
  if (encoded.size >= ENCODED_MAX) encoded.clear();
  encoded.set(fn, parsed);
  return parsed;
}

/** Whether a model name has a cut name's shape: 64 characters ending in `_x` and 8 hex. */
export function looksCut(name: string): boolean {
  return name.length === MODEL_FN_NAME_MAX && /_x[0-9a-f]{8}$/.test(name);
}

/** Whether a fn's model name was cut (and so can be read back only through the registry). */
export function isCutModelName(fn: QualifiedName): boolean {
  return fullModelName(fn).length > MODEL_FN_NAME_MAX;
}

/**
 * The fn a model name means by the rule alone: the first `__` ends the system, each later `__` is a `.`. Undefined for a
 * name that is no fn's model name by rule (a cut name, a static tool's name, anything else): those read back only
 * through the registry.
 */
export function fnOfModelNameByRule(name: string): QualifiedName | undefined {
  // a name of a cut's shape is read only through the registry, even when the rule could read it as another fn
  if (looksCut(name)) return undefined;
  const at = name.indexOf('__');
  if (at <= 0) return undefined;
  const system = name.slice(0, at);
  const local = name.slice(at + 2).split('__').join('.');
  if (!SYSTEM_NAME_PATTERN.test(system) || !FN_LOCAL_NAME_PATTERN.test(local)) return undefined;
  const fn = QualifiedName.safeParse(`${system}/${local}`);
  return fn.success && !isCutModelName(fn.data) && fullModelName(fn.data) === name ? fn.data : undefined;
}

/**
 * The fn a tool name in a stored model call means, for people only (the LLM call view, the run inspector): a qualified
 * name as it is, a model name by the new rule (or, given `cut`, a cut one the hub looked up), else the legacy spelling
 * stored calls from before the one name kept (`fs__Entry--reveal`, `/` as `__` and `.` as `--`). Display only: the hub
 * reads the model's calls through its registry, never this.
 */
export function fnOfStoredToolName(name: string, cut?: (name: string) => QualifiedName | undefined): QualifiedName | undefined {
  const given = QualifiedName.safeParse(name);
  if (given.success) return given.data;
  const looked = cut?.(name);
  if (looked !== undefined) return looked;
  // `--` was the legacy spelling of a method's `.`, which a model name never holds
  return name.includes('--') ? legacyFnOfToolName(name) ?? fnOfModelNameByRule(name) : fnOfModelNameByRule(name) ?? legacyFnOfToolName(name);
}

/** The legacy tool spelling read back (`/` as `__`, `.` as `--`), kept only for stored model calls' display. */
export function legacyFnOfToolName(name: string): QualifiedName | undefined {
  // the legacy rule cut at 64 with no mark, so a name that long may be any of several fns: none is read
  if (name.length >= MODEL_FN_NAME_MAX) return undefined;
  const guess = QualifiedName.safeParse(name.replace('__', '/').replaceAll('--', '.'));
  if (!guess.success) return undefined;
  const legacy = guess.data.replaceAll('/', '__').replaceAll('.', '--').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MODEL_FN_NAME_MAX);
  return legacy === name ? guess.data : undefined;
}

// ─── The registry's interface ─────────────────────────────────────────────────

/** A model name the registry gave out whose fn is gone (a deleted saved fn), so an old call still reads back for people. */
export const ModelFnNameHistory = z.object({ model: ModelFnName, fn: QualifiedName, until: Timestamp });
export type ModelFnNameHistory = z.infer<typeof ModelFnNameHistory>;

/** The registry of model names: every fn the hub has (saved fns and methods included), each encoded once, and history. */
export interface ModelFnNameIndex {
  /** The fn a model name was given out for: a fn's now, else one that is gone; undefined when it names none. */
  fnOf(model: string): QualifiedName | undefined;
  /** Whether a qualified name is a fn's now (for finding fns in text). */
  isFn(name: string): boolean;
}

/**
 * The registry over a set of fn names, in memory: what the hub's is made of (filled from its catalog and history
 * table) and what tests and fixtures build from a list. A second fn whose model name is taken is a `collision`.
 */
export class FnNameIndex implements ModelFnNameIndex {
  readonly #byModel = new Map<string, QualifiedName>();
  readonly #fns = new Set<string>();
  readonly #gone = new Map<string, ModelFnNameHistory>();

  /** A registry of these fns, with the names of fns that are gone. */
  static of(fns: Iterable<QualifiedName>, history: Iterable<ModelFnNameHistory> = []): FnNameIndex {
    const index = new FnNameIndex();
    for (const entry of history) index.#gone.set(entry.model, entry);
    for (const fn of fns) index.add(fn);
    return index;
  }

  fnOf(model: string): QualifiedName | undefined {
    return this.#byModel.get(model) ?? this.#gone.get(model)?.fn;
  }

  isFn(name: string): boolean {
    return this.#fns.has(name);
  }

  /** The fn that already holds this fn's model name, if another does: two fns that encode the same are refused. */
  collision(fn: QualifiedName): QualifiedName | undefined {
    const holder = this.#byModel.get(modelFnName(fn));
    return holder === undefined || holder === fn ? undefined : holder;
  }

  /** Add a fn (a collision keeps the first). */
  add(fn: QualifiedName): void {
    const model = modelFnName(fn);
    this.#fns.add(fn);
    if (!this.#byModel.has(model)) this.#byModel.set(model, fn);
  }

  /** Take a fn out; its model name moves to the history it returns, so old calls still read back. */
  remove(fn: QualifiedName, until: Timestamp): ModelFnNameHistory | undefined {
    if (!this.#fns.delete(fn)) return undefined;
    const model = modelFnName(fn);
    if (this.#byModel.get(model) === fn) this.#byModel.delete(model);
    const entry: ModelFnNameHistory = { model, fn, until };
    this.#gone.set(model, entry);
    return entry;
  }

  /** How many fns it holds now. */
  get size(): number {
    return this.#fns.size;
  }
}

/** A registry that knows no fn: names read back by the rule alone, and text keeps only its `fn:` refs. */
export const RULE_ONLY_NAMES: ModelFnNameIndex = { fnOf: () => undefined, isFn: () => false };

// ─── A fn's name as a value ───────────────────────────────────────────────────

/**
 * The text pattern that marks a gin text as a fn's name (`g.fnName()` in the SDK): the boundary converts such fields
 * both ways. It takes a model name, a static tool's name and a qualified name alike (any text with no spaces that starts
 * with a letter: `hub/inspect` also takes a resource's URI), since the model writes the first, code and people the last.
 */
export const FN_NAME_PATTERN = '^[a-z]\\S*$';
/** What a fn-name field tells the model, in its tool's JSON schema. */
export const FN_NAME_DESCRIPTION = 'A fn\'s name, as your tools spell it.';

/**
 * A fn's name as a value in core's zod schemas (a hub fn's args or result): a qualified name in code, the model name to
 * the model. `ginOf` makes it `g.fnName()`. Its description marks it, so keep it when wrapping (`.optional()` keeps it).
 */
export const FnNameValue = QualifiedName.describe(FN_NAME_DESCRIPTION);

/** Whether a gin type definition is a fn's name (`g.fnName()`). */
export function isFnNameDef(def: GinTypeDef): boolean {
  const options: unknown = def.options;
  return def.name === 'text' && typeof options === 'object' && options !== null && 'pattern' in options && options.pattern === FN_NAME_PATTERN;
}

// ─── The boundary ─────────────────────────────────────────────────────────────

/** The hub fns static mode's tools stand for, by tool: `fn` is the tool's own hub fn, `also` the fns whose jobs it does. */
export type StaticToolFns = Readonly<Record<string, { readonly fn: QualifiedName; readonly also?: readonly QualifiedName[] }>>;

/** The chat mode names are for: tools mode, or static mode with its tools' hub fns. */
export type ModelNamesMode = { readonly type: 'tools' } | { readonly type: 'static'; readonly tools: StaticToolFns };

/** The hub's fn names for one prompt: built from its fn registry (every name it has given out) and the chat's mode. */
export interface ModelFnNames {
  /** The name the model calls this fn by here: its model name, or in static mode the static tool that does its job. */
  name(fn: QualifiedName): string;
  /** The fn a name from the model means (a model name, a static tool's name, or, tolerated, a qualified name); undefined when it names none. */
  fn(name: string): QualifiedName | undefined;
  /** Text for the model: each `fn:` ref and each known fn's qualified name standing alone, as `name` gives it; `context:` refs as the plain key. */
  text(text: string): string;
  /** A value for the model: `g.fnName()` fields as `name` gives them, text fields through `text`. */
  value(value: Json, type: GinTypeDef | undefined): Json;
  /** A value from the model: `g.fnName()` fields read back. */
  read(value: Json, type: GinTypeDef): Json;
}

/** What `modelFnNames` is built from. */
export interface ModelFnNamesInput {
  readonly index: ModelFnNameIndex;
  readonly mode: ModelNamesMode;
  /** Named types' definitions, for values whose type names one; absent, a named type's fields are left as they are. */
  readonly types?: ((name: string) => GinTypeDef | undefined) | undefined;
}

/**
 * A fn's name in text: a system, `/`, and a local name. Not after `/`, `:`, `.`, `-`, `_` or a letter or digit, so a
 * path (`docs/fs/read.md`, `file:///repo/fs/read`) is never read as one; `fn:` and `context:` refs are taken whole.
 */
const NAME_IN_TEXT = /(?<![A-Za-z0-9_./:-])(fn:|context:)?([a-z][a-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)/g;

/** A name with its trailing `.` and `-` (a sentence's full stop) taken off, and what was taken. */
function trimmed(name: string): { name: string; rest: string } {
  const match = /[.-]+$/.exec(name);
  return match === null ? { name, rest: '' } : { name: name.slice(0, match.index), rest: match[0] };
}

/** The names for one prompt. */
export function modelFnNames(input: ModelFnNamesInput): ModelFnNames {
  const { index, mode, types } = input;
  const standIn = new Map<string, string>();
  const toolFn = new Map<string, QualifiedName>();
  if (mode.type === 'static') {
    for (const [tool, { fn, also }] of Object.entries(mode.tools)) {
      toolFn.set(tool, fn);
      standIn.set(fn, tool);
      for (const other of also ?? []) if (!standIn.has(other)) standIn.set(other, tool);
    }
  }
  const name = (fn: QualifiedName): string => standIn.get(fn) ?? modelFnName(fn);
  const fn = (given: string): QualifiedName | undefined => {
    const tool = toolFn.get(given);
    if (tool !== undefined) return tool;
    const known = index.fnOf(given);
    if (known !== undefined) return known;
    const qualified = QualifiedName.safeParse(given);
    if (qualified.success) return qualified.data;
    return fnOfModelNameByRule(given);
  };
  const text = (source: string): string => source.replace(NAME_IN_TEXT, (whole, ref: string | undefined, found: string) => {
    if (ref === 'context:') return found;
    let { name: candidate, rest } = trimmed(found);
    // a bare name that isn't a fn may still end in one (`fs/read.` at a sentence's end): the longest known one wins
    while (ref === undefined && !index.isFn(candidate) && candidate.includes('.')) {
      const cut = candidate.lastIndexOf('.');
      rest = candidate.slice(cut) + rest;
      candidate = candidate.slice(0, cut);
    }
    const qualified = QualifiedName.safeParse(candidate);
    if (!qualified.success || (ref === undefined && !index.isFn(candidate))) return whole;
    return `${name(qualified.data)}${rest}`;
  });
  const walker = { name, fn, text, types };
  return {
    name, fn, text,
    value: (value, type) => outward(value, type, walker),
    read: (value, type) => inward(value, type, walker),
  };
}

/** What the value walkers use. */
interface Walker {
  readonly name: (fn: QualifiedName) => string;
  readonly fn: (name: string) => QualifiedName | undefined;
  readonly text: (text: string) => string;
  readonly types: ((name: string) => GinTypeDef | undefined) | undefined;
}

/** How deep a named type may refer to itself before the walk stops following it. */
const MAX_DEPTH = 32;

/** A value for the model: fn-name fields as their names here, every other text through `text`. */
function outward(value: Json, type: GinTypeDef | undefined, walker: Walker, depth = 0): Json {
  if (typeof value === 'string') {
    if (type !== undefined && isFnNameDef(type)) { const qualified = QualifiedName.safeParse(value); return qualified.success ? walker.name(qualified.data) : value; }
    return walker.text(value);
  }
  if (value === null || typeof value !== 'object') return value;
  const def = type === undefined || depth > MAX_DEPTH ? undefined : resolved(type, walker);
  if (Array.isArray(value)) return value.map((item, i) => outward(item, def === undefined ? undefined : elementOf(def, i), walker, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, outward(item, def === undefined ? undefined : fieldOf(def, key), walker, depth + 1)]));
}

/** A value from the model: fn-name fields read back to qualified names; nothing else changes. */
function inward(value: Json, type: GinTypeDef | undefined, walker: Walker, depth = 0): Json {
  if (type === undefined || depth > MAX_DEPTH) return value;
  const def = resolved(type, walker);
  if (def === undefined) return value;
  if (typeof value === 'string') return isFnNameDef(def) ? walker.fn(value) ?? value : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item, i) => inward(item, elementOf(def, i), walker, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inward(item, fieldOf(def, key), walker, depth + 1)]));
}

/** A type without its `optional` and `nullable` wrappers, a named type as its definition (undefined when unknown). */
function resolved(type: GinTypeDef, walker: Walker): GinTypeDef | undefined {
  let at: GinTypeDef | undefined = type;
  for (let hops = 0; at !== undefined && hops < MAX_DEPTH; hops++) {
    if ((at.name === 'optional' || at.name === 'nullable') && at.generic?.['T'] !== undefined) { at = at.generic['T']; continue; }
    // a named type (or an extension of one) is looked up; one that carries its own props is read as an object
    if (at.name.includes('/') && at.props === undefined) { at = walker.types?.(at.name); continue; }
    return at;
  }
  return at;
}

/** The type of a list's or tuple's i-th item. */
function elementOf(def: GinTypeDef, i: number): GinTypeDef | undefined {
  if (def.name === 'list') return def.generic?.['V'];
  if (def.name === 'tuple') return listOption(def, 'elements')[i];
  if (def.name === 'or' || def.name === 'and') return listOption(def, 'types').find((option) => option.name === 'list' || option.name === 'tuple');
  return undefined;
}

/** The type of an object's field. */
function fieldOf(def: GinTypeDef, key: string): GinTypeDef | undefined {
  if (def.props !== undefined) return def.props[key]?.type;
  if (def.name === 'map') return def.generic?.['V'];
  if (def.name === 'or' || def.name === 'and') {
    // the option whose props hold the field (a discriminated union names its own fields)
    for (const option of listOption(def, 'types')) {
      const field = option.props?.[key]?.type;
      if (field !== undefined) return field;
    }
  }
  return undefined;
}

/** A list of type definitions in a type's options (`or`'s `types`, `tuple`'s `elements`). */
function listOption(def: GinTypeDef, key: 'types' | 'elements'): GinTypeDef[] {
  const options: unknown = def.options;
  if (typeof options !== 'object' || options === null || !(key in options)) return [];
  const list: unknown = Reflect.get(options, key);
  return Array.isArray(list) ? list.filter((item: unknown): item is GinTypeDef => typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string') : [];
}

// ─── sha-256, synchronous ─────────────────────────────────────────────────────

/** sha-256's round constants. */
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * The sha-256 of a text's UTF-8 bytes, as lowercase hex, worked out at once (Web Crypto's digest is async, and a model
 * name is needed while text is rendered). Only for names: short input, no secrets.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length;
  const blocks = Math.ceil((length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(data.length - 4, (length * 8) >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const sums = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (sums[i] ?? 0)) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
