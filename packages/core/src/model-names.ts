/**
 * The one name the model sees for a fn (plan `injected-context-2026-11-22`, section 1). A fn's **model name** is its
 * qualified name with every `/` and `.` written `__` (`database/main.expenses_create` → `database__main__expenses_create`),
 * a valid tool name for every provider; past 64 characters it is cut to 54 and ended with `_x` and 8 hex of the
 * qualified name's sha-256. Only fns have model names: context keys, types and hook tags keep their own forms. The
 * format is computable from the name, so text spells every fn-shaped name of an installed system by it, an example name
 * no fn holds included (`isFnShaped`); only reading a cut name back needs the registry.
 *
 * This module owns the encoder, the rule a fn's local name keeps so its model name reads back (`FnLocalName`), the
 * registry's interface (`ModelFnNameRegistry`, batched: the hub's answers from its `modelFnNames` and history tables
 * with indexed queries), the one conversion every boundary uses (`modelFnNames`: text and values out to the model,
 * names and values back in, after one `learn` per prompt), and the build's check of names in authored text
 * (`unresolvedNamesIn`). Nothing else spells a model name.
 */
import { z } from 'zod';
import type { GinTypeDef } from './gin.ts';
import { type Json, QualifiedName, SYSTEM_NAME_PATTERN, SystemName, splitName, Timestamp } from './primitives.ts';

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

/**
 * One fn's model name as the hub stores it (the `modelFnNames` table, keyed by `model`, indexed by `fn` and `system`):
 * written in the transaction that stores the fn, removed with it (its name moving to the history table).
 */
export const ModelFnNameRow = z.object({ model: ModelFnName, fn: QualifiedName, system: SystemName });
export type ModelFnNameRow = z.infer<typeof ModelFnNameRow>;

/**
 * The registry of model names: every fn the hub has (saved fns and methods included), each encoded once, and the
 * history of names whose fns are gone. Batched: a prompt collects the names it meets and asks once (`ModelFnNames.learn`),
 * so the hub's answers with an indexed query or two however many fns it holds; nothing loads every name.
 */
export interface ModelFnNameRegistry {
  /** Of these qualified names, the ones that are fns now (for finding fns in text). */
  fnsAmong(names: readonly QualifiedName[]): Promise<ReadonlySet<QualifiedName>>;
  /** The fns these model names were given out for: a fn's now, else one that is gone. A name it never gave out is absent. */
  fnsOf(models: readonly string[]): Promise<ReadonlyMap<string, QualifiedName>>;
  /**
   * What the rule needs for names no fn holds (`ModelFnNames.text`, Phil 2026-11-22 "Encode by rule"): of these names,
   * the systems that are installed, and the names that are context keys, kinds or types (which keep their `/`). Absent,
   * only fns are spelled as model names.
   */
  shapesAmong?(names: readonly QualifiedName[]): Promise<NameShapes>;
}

/** What a registry knows of names no fn holds: the installed systems among theirs, and which are context keys, kinds or types. */
export interface NameShapes {
  readonly systems: ReadonlySet<string>;
  readonly reserved: ReadonlySet<string>;
}

/**
 * Whether a name no fn holds is still a fn's name in shape, and so spelled as a model name by rule: its system is
 * installed (`systems`), its local name is one a model name carries (`FnLocalName`) and is not a type's (one
 * capitalised part, `fs/Entry`), and neither it nor a name it ends in at a `.` is a context key, kind or type
 * (`reserved`: `database/guide`, `database/query`, `database/guide.md`). Example names (`database/main.overdue_invoices`,
 * `input/project_details`) are fn-shaped; their model name is computable without any fn holding it.
 */
export function isFnShaped(name: QualifiedName, systems: ReadonlySet<string>, reserved: ReadonlySet<string>): boolean {
  const { system, local } = splitName(name);
  if (!systems.has(system) || !FN_LOCAL_NAME_PATTERN.test(local)) return false;
  if (!local.includes('.') && /^[A-Z]/.test(local)) return false;
  for (let candidate: string = name; ; ) {
    if (reserved.has(candidate)) return false;
    const cut = candidate.lastIndexOf('.');
    if (cut <= candidate.indexOf('/')) return true;
    candidate = candidate.slice(0, cut);
  }
}

/**
 * The registry over a set of fn names, in memory: what tests and fixtures build from a list (the hub's is its store's
 * `modelFnNames` table). A second fn whose model name is taken is a `collision`.
 */
export class FnNameIndex implements ModelFnNameRegistry {
  readonly #byModel = new Map<string, QualifiedName>();
  readonly #fns = new Set<string>();
  readonly #gone = new Map<string, ModelFnNameHistory>();
  readonly #systems = new Set<string>();
  readonly #reserved = new Set<string>();

  /**
   * A registry of these fns, with the names of fns that are gone; `shapes`, the installed systems and the context keys,
   * kinds and types, for the rule that spells names no fn holds (absent: only fns are spelled).
   */
  static of(fns: Iterable<QualifiedName>, history: Iterable<ModelFnNameHistory> = [], shapes?: { systems?: Iterable<string>; reserved?: Iterable<string> }): FnNameIndex {
    const index = new FnNameIndex();
    for (const entry of history) index.#gone.set(entry.model, entry);
    for (const fn of fns) index.add(fn);
    for (const system of shapes?.systems ?? []) index.#systems.add(system);
    for (const name of shapes?.reserved ?? []) index.#reserved.add(name);
    return index;
  }

  shapesAmong(names: readonly QualifiedName[]): Promise<NameShapes> {
    const systems = new Set(names.map((name) => splitName(name).system).filter((system) => this.#systems.has(system)));
    return Promise.resolve({ systems, reserved: new Set(names.filter((name) => this.#reserved.has(name))) });
  }

  /** The fn a model name was given out for: a fn's now, else one that is gone; undefined when it names none. */
  fnOf(model: string): QualifiedName | undefined {
    return this.#byModel.get(model) ?? this.#gone.get(model)?.fn;
  }

  /** Whether a qualified name is a fn's now. */
  isFn(name: string): boolean {
    return this.#fns.has(name);
  }

  fnsAmong(names: readonly QualifiedName[]): Promise<ReadonlySet<QualifiedName>> {
    return Promise.resolve(new Set(names.filter((name) => this.#fns.has(name))));
  }

  fnsOf(models: readonly string[]): Promise<ReadonlyMap<string, QualifiedName>> {
    const found = new Map<string, QualifiedName>();
    for (const model of models) { const fn = this.fnOf(model); if (fn !== undefined) found.set(model, fn); }
    return Promise.resolve(found);
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
export const RULE_ONLY_NAMES: ModelFnNameRegistry = { fnsAmong: () => Promise.resolve(new Set()), fnsOf: () => Promise.resolve(new Map()) };

// ─── A fn's name as a value ───────────────────────────────────────────────────

/**
 * The text pattern that marks a gin text as a fn's name (`g.fnName()` in the SDK), and what such a field tells the
 * model (`gin-a.ts`, where a prompt's tools read it as its `FnName` codec). It takes a model name, a static tool's name
 * and a qualified name alike (any text with no spaces that starts with a letter: `hub/inspect` also takes a resource's
 * URI), since the model writes the first, code and people the last.
 */
export { FN_NAME_DESCRIPTION, FN_NAME_PATTERN } from './gin-a.ts';
import { FN_NAME_DESCRIPTION, FN_NAME_PATTERN } from './gin-a.ts';

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

/** A name written the way the model's tools spell names: a system, `__`, then parts joined by `__` (`database__main__expenses`). */
const UNDERSCORED_NAME = /^([a-z][a-z0-9-]*)__(\S+)$/;

/**
 * A name that is not a fn's (a type, or a glob over fn names) written as the model may write it, read as the hub keeps
 * it: a name with a `/` is kept as it is; one in the tools' spelling (`database__main__expenses`, `fs__*`) gets its `/`
 * and `.`s back by the rule (`database/main.expenses`, `fs/*`); anything else (a bare `expenses`) is left as it is,
 * for the caller to match.
 */
export function slashedName(given: string): string {
  const name = given.trim();
  if (name.includes('/')) return name;
  const match = UNDERSCORED_NAME.exec(name);
  if (match === null || match[1] === undefined || match[2] === undefined) return name;
  const parts = match[2].split('__');
  return parts.some((part) => part === '') ? name : `${match[1]}/${parts.join('.')}`;
}

/**
 * A type's name as a filter or an arg takes it: the type's name (`database/main.expenses`), the same in the tools'
 * spelling (`database__main__expenses`), or a bare name (`expenses`, `main.expenses`), which matches every type whose
 * name ends in it (`typeMatches`). Types keep their own form when shown (plan `injected-context-2026-11-22`, "fns only").
 */
export const TypeNameRef = z.string().min(1).regex(/^\S+$/, 'a type\'s name, with no spaces');
export type TypeNameRef = z.infer<typeof TypeNameRef>;

/** Whether a type's qualified name is the one a `TypeNameRef` means (read with `slashedName` first). */
export function typeMatches(type: string, ref: string): boolean {
  const wanted = slashedName(ref);
  if (wanted.includes('/')) return type === wanted;
  return type.endsWith(`/${wanted}`) || type.endsWith(`.${wanted}`);
}

// ─── The boundary ─────────────────────────────────────────────────────────────

/** The hub fns static mode's tools stand for, by tool: `fn` is the tool's own hub fn, `also` the fns whose jobs it does. */
export type StaticToolFns = Readonly<Record<string, { readonly fn: QualifiedName; readonly also?: readonly QualifiedName[] }>>;

/** The chat mode names are for: tools mode, or static mode with its tools' hub fns. */
export type ModelNamesMode = { readonly type: 'tools' } | { readonly type: 'static'; readonly tools: StaticToolFns };

/**
 * The hub's fn names for one prompt (or one batch of replies): built from its fn registry and the chat's mode. The
 * registry is asked in batches, so a caller first `learn`s what it will spell or read (one or two indexed queries for
 * everything), then spells and reads synchronously. What it learns is kept for this object only: one prompt, one turn.
 * A bare name it never learned is left as written, so learn every text before `text` (and every value before `value`).
 */
export interface ModelFnNames {
  /**
   * Ask the registry, in one batch, about every name these texts and values may hold that this object hasn't met: the
   * bare `system/name` tokens (is each a fn? is its system installed? is it a context key, kind or type?) and the
   * cut-shaped model names (which fn was each given out for?).
   */
  learn(sources: Iterable<Json | undefined>): Promise<void>;
  /** The name the model calls this fn by here: its model name, or in static mode the static tool that does its job. */
  name(fn: QualifiedName): string;
  /** The fn a name from the model means (a model name, a static tool's name, or, tolerated, a qualified name); undefined when it names none. */
  fn(name: string): QualifiedName | undefined;
  /**
   * Text for the model: each `fn:` ref and each known fn's qualified name standing alone, as `name` gives it; each other
   * fn-shaped name (`isFnShaped`: an example such as `database/main.overdue_invoices`) by the rule; `context:` refs as
   * the plain key. Context keys, kinds and types keep their `/`.
   */
  text(text: string): string;
  /** A value for the model: `g.fnName()` fields as `name` gives them, text fields through `text`. */
  value(value: Json, type: GinTypeDef | undefined): Json;
  /** A value from the model: `g.fnName()` fields read back. */
  read(value: Json, type: GinTypeDef): Json;
}

/** What `modelFnNames` is built from. */
export interface ModelFnNamesInput {
  readonly index: ModelFnNameRegistry;
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

/** A cut model name in text (64 characters ending `_x` and 8 hex), standing alone. */
const CUT_IN_TEXT = /(?<![A-Za-z0-9_-])[a-z][A-Za-z0-9_-]{53}_x[0-9a-f]{8}(?![A-Za-z0-9_-])/g;

/**
 * The bare `system/name` tokens of a text that `text` asks the registry about: each standing-alone name (no `fn:` or
 * `context:` ref, which need no asking) with its trailing `.`/`-` taken off, and each shorter name it ends in at a `.`
 * (`fs/read.` at a sentence's end, `fs/Entry.reveal.more`), as `text` tries them.
 */
export function bareNamesIn(text: string): QualifiedName[] {
  const found = new Set<QualifiedName>();
  for (const match of text.matchAll(NAME_IN_TEXT)) {
    if (match[1] !== undefined || match[2] === undefined) continue;
    let candidate = trimmed(match[2]).name;
    for (;;) {
      const qualified = QualifiedName.safeParse(candidate);
      if (qualified.success) found.add(qualified.data);
      const cut = candidate.lastIndexOf('.');
      if (cut <= candidate.indexOf('/')) break;
      candidate = candidate.slice(0, cut);
    }
  }
  return [...found];
}

/** The cut-shaped model names in a text (or a text that is one), which read back only through the registry. */
export function cutNamesIn(text: string): string[] {
  return [...new Set(text.match(CUT_IN_TEXT) ?? [])];
}

/** Every string in a JSON value (keys left out). */
function* stringsOf(value: Json | undefined): Generator<string> {
  if (typeof value === 'string') { yield value; return; }
  if (value === null || typeof value !== 'object') return;
  for (const item of Array.isArray(value) ? value : Object.values(value)) yield* stringsOf(item);
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
  // what this object has learned: which bare names are fns (and which aren't), and which fn each model name means
  const fns = new Set<string>();
  const asked = new Set<string>();
  const byModel = new Map<string, QualifiedName>();
  // for the rule: the installed systems and the context keys, kinds and types among the names met
  const systems = new Set<string>();
  const reserved = new Set<string>();
  const isFn = (candidate: string): boolean => fns.has(candidate);
  const learn = async (sources: Iterable<Json | undefined>): Promise<void> => {
    const bare = new Set<QualifiedName>();
    const cut = new Set<string>();
    for (const source of sources) {
      for (const text of stringsOf(source)) {
        for (const candidate of bareNamesIn(text)) if (!asked.has(candidate)) bare.add(candidate);
        for (const model of cutNamesIn(text)) if (!asked.has(model) && !byModel.has(model)) cut.add(model);
      }
    }
    if (bare.size === 0 && cut.size === 0) return;
    const none: NameShapes = { systems: new Set(), reserved: new Set() };
    const [among, of, shapes] = await Promise.all([
      bare.size === 0 ? new Set<QualifiedName>() : index.fnsAmong([...bare]),
      cut.size === 0 ? new Map<string, QualifiedName>() : index.fnsOf([...cut]),
      bare.size === 0 || index.shapesAmong === undefined ? none : index.shapesAmong([...bare]),
    ]);
    for (const candidate of bare) asked.add(candidate);
    for (const model of cut) asked.add(model);
    for (const found of among) fns.add(found);
    for (const [model, found] of of) byModel.set(model, found);
    for (const system of shapes.systems) systems.add(system);
    for (const name of shapes.reserved) reserved.add(name);
  };
  const name = (fn: QualifiedName): string => {
    const stood = standIn.get(fn);
    if (stood !== undefined) return stood;
    const model = modelFnName(fn);
    // a name given out here reads back here, a cut one too
    if (!byModel.has(model)) byModel.set(model, fn);
    return model;
  };
  const fn = (given: string): QualifiedName | undefined => {
    const tool = toolFn.get(given);
    if (tool !== undefined) return tool;
    const known = byModel.get(given);
    if (known !== undefined) return known;
    const qualified = QualifiedName.safeParse(given);
    if (qualified.success) return qualified.data;
    return fnOfModelNameByRule(given);
  };
  const text = (source: string): string => source.replace(NAME_IN_TEXT, (whole, ref: string | undefined, found: string, at: number) => {
    if (ref === 'context:') return found;
    const given = trimmed(found);
    let { name: candidate, rest } = given;
    // a bare name that isn't a fn may still end in one (`fs/read.` at a sentence's end): the longest known one wins
    while (ref === undefined && !isFn(candidate) && candidate.lastIndexOf('.') > candidate.indexOf('/')) {
      const cut = candidate.lastIndexOf('.');
      rest = candidate.slice(cut) + rest;
      candidate = candidate.slice(0, cut);
    }
    const qualified = QualifiedName.safeParse(candidate);
    if (qualified.success && (ref !== undefined || isFn(candidate))) return `${name(qualified.data)}${rest}`;
    // no fn holds it, but it has a fn name's shape (an example name, a saved fn yet to be made): spelled by the rule,
    // except as an attribute's value (`provider="fs/files"`), where only a known fn is a fn
    const shaped = QualifiedName.safeParse(given.name);
    const inAttribute = source.slice(Math.max(0, at - 2), at) === '="';
    if (ref === undefined && !inAttribute && shaped.success && isFnShaped(shaped.data, systems, reserved)) return `${modelFnName(shaped.data)}${given.rest}`;
    return whole;
  });
  const walker = { name, fn, text, types };
  return {
    learn, name, fn, text,
    value: (value, type) => outward(value, type, walker),
    read: (value, type) => inward(value, type, walker),
  };
}

// ─── Authored text ────────────────────────────────────────────────────────────

/** The names authored text may name, qualified, for the build's check (`unresolvedNamesIn`). */
export interface AuthoredNames {
  readonly fns: ReadonlySet<string>;
  readonly context: ReadonlySet<string>;
  /** Named types and kinds (the other names a text may give). */
  readonly types: ReadonlySet<string>;
  /** The systems whose names are checked: a bare `x/y` whose `x` is none of these (a path, `src/index.ts`) is left alone. */
  readonly systems: ReadonlySet<string>;
}

/** A name in authored text that resolves to nothing the build knows. */
export interface UnresolvedName {
  /** As written, without its ref. */
  readonly name: string;
  /** The ref it was written with (`fn:`, `context:`), or none for a bare name. */
  readonly ref: 'fn' | 'context' | undefined;
  /** Where it starts in the text (0-based). */
  readonly index: number;
}

/**
 * The names in model-facing text (a description, instructions, an example's note, a context body) that name nothing
 * the build knows: a `fn:` ref that is no fn, a `context:` ref that is no context item, and a bare `system/name` that
 * is no fn, context item, type or kind (nor ends in one at a `.`), each of a system in `known.systems`. A saved fn's
 * name (`database/main.expenses`) and a family (`input/ask_`) are examples the build can't know, so they are left
 * alone. The hub renders refs and bare fns as model names (`ModelFnNames.text`); a name that resolves to nothing is
 * a stale or misspelt sentence.
 */
export function unresolvedNamesIn(text: string, known: AuthoredNames): UnresolvedName[] {
  const out: UnresolvedName[] = [];
  const anything = (name: string): boolean => known.fns.has(name) || known.context.has(name) || known.types.has(name);
  for (const match of text.matchAll(NAME_IN_TEXT)) {
    const [, ref, found] = match;
    if (found === undefined) continue;
    let candidate = trimmed(found).name;
    const qualified = QualifiedName.safeParse(candidate);
    if (!qualified.success) continue;
    const { system, local } = splitName(qualified.data);
    if (!known.systems.has(system)) continue;
    if (ref === 'fn:' || ref === 'context:') {
      const kind = ref === 'fn:' ? 'fn' : 'context';
      if (!(kind === 'fn' ? known.fns : known.context).has(candidate)) out.push({ name: candidate, ref: kind, index: match.index });
      continue;
    }
    // a saved fn's name (`database/main.expenses`: an instance, then its name) is an example the build can't know,
    // and a name ending in `_` is a family (`input/ask_…`)
    const head = local.split('.')[0] ?? local;
    if ((local.includes('.') && !known.types.has(`${system}/${head}`)) || local.endsWith('_')) continue;
    while (!anything(candidate) && candidate.lastIndexOf('.') > candidate.indexOf('/')) candidate = candidate.slice(0, candidate.lastIndexOf('.'));
    if (!anything(candidate)) out.push({ name: trimmed(found).name, ref: undefined, index: match.index });
  }
  return out;
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
  const shape = def === undefined ? undefined : optionFor(def, value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, outward(item, shape === undefined ? undefined : fieldOf(shape, key), walker, depth + 1)]));
}

/** A value from the model: fn-name fields read back to qualified names; nothing else changes. */
function inward(value: Json, type: GinTypeDef | undefined, walker: Walker, depth = 0): Json {
  if (type === undefined || depth > MAX_DEPTH) return value;
  const def = resolved(type, walker);
  if (def === undefined) return value;
  if (typeof value === 'string') return isFnNameDef(def) ? walker.fn(value) ?? value : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item, i) => inward(item, elementOf(def, i), walker, depth + 1));
  const shape = optionFor(def, value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inward(item, fieldOf(shape, key), walker, depth + 1)]));
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

/**
 * The option of a union an object value is: the one whose literal fields (a discriminated union's `kind`) all match
 * the value's, so a field two options share (`name`: a context key in one, a fn's name in another) is read by the
 * right one. Any other type, or a union no option of which matches by a literal, is returned as it is.
 */
function optionFor(def: GinTypeDef, value: { readonly [key: string]: Json }): GinTypeDef {
  if (def.name !== 'or') return def;
  for (const option of listOption(def, 'types')) {
    const literals = Object.entries(option.props ?? {}).filter(([, prop]) => prop.type.name === 'literal');
    if (literals.length === 0) continue;
    const fits = literals.every(([key, prop]) => {
      const options: unknown = prop.type.options;
      return typeof options === 'object' && options !== null && 'value' in options && options.value === value[key];
    });
    if (fits) return option;
  }
  return def;
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
