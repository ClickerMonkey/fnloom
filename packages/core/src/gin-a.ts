/**
 * gin types as `@aeye/schema` (`a`) schemas: what a model is shown and what a value is checked with. gin's `toA` maps
 * every type; the harness adds its one model-facing difference, a fn's name (`g.fnName()`, a text of
 * `FN_NAME_PATTERN`): it is the named type `FnName`, which a prompt supplies as a codec over its `ModelFnNames` (the
 * model reads and writes the model name, code holds the qualified name). Everything else is gin's grammar
 * (`GinGrammarStatic`, its registry step `grammarDefs`), so `typ`, `fn` and registered named types are refs into it.
 *
 * - `HarnessGrammar`: gin's grammar plus `FnName`, bound with `(registry, names?, overrides?)`. Without names, a
 *   fn-name field is the plain text it is to gin (code callers, people, the web).
 * - `ginArgsA(type, opts)`: a type's value schema in that grammar (`FnName` refs where gin has fn-name texts).
 * - `checkGinValue(type, value, opts)`: the value check every caller of a gin type uses (a run's args, a form, a
 *   value a system sends): the code shape (`LENIENT`), its problems by dotted path.
 */
import { GinGrammarStatic, grammarDefs, grammarKey, type BuildSchemasOverrides, type Registry, type Type, type TypeScope } from '@aeye/gin';
import { a, LENIENT, type AnySchema, type Bound, type Bundle, type Issue, type SchemaOf } from '@aeye/schema';
import type { QualifiedName } from './primitives.ts';

/** The text pattern that marks a gin text as a fn's name (`g.fnName()`); `model-names.ts` re-exports it. */
export const FN_NAME_PATTERN = '^[a-z]\\S*$';
/** What a fn-name field tells the model, in its tool's JSON schema. */
export const FN_NAME_DESCRIPTION = 'A fn\'s name, as your tools spell it.';

/** The part of a prompt's `ModelFnNames` a fn-name field needs: the name both ways (learned before decoding). */
export interface FnNameSpelling {
  /** The name the model calls this fn by here. */
  name(fn: QualifiedName): string;
  /** The fn a name from the model means; undefined when it names none. */
  fn(name: string): QualifiedName | undefined;
}

/** Whether a gin type is a fn's name (`g.fnName()`). */
export function isFnNameType(type: Type): boolean {
  if (type.name !== 'text') return false;
  const options: unknown = type.options;
  return typeof options === 'object' && options !== null && 'pattern' in options && options.pattern === FN_NAME_PATTERN;
}

/** A fn-name field without a prompt: the text gin has (a qualified name, or a model name a person pasted). */
const PLAIN_FN_NAME = a.string().pattern(FN_NAME_PATTERN).describe(FN_NAME_DESCRIPTION);

/**
 * A fn-name field for one prompt: the model writes the name its tools spell, code holds the qualified name. A name
 * that names no fn is told back to the model with what to write instead.
 */
export function fnNameCodec(names: FnNameSpelling): AnySchema {
  return a.codec(PLAIN_FN_NAME, {
    decode: (wire: string): QualifiedName | Error => names.fn(wire) ?? new Error(`${wire} names no fn: write a fn's name as your tools spell it.`),
    encode: (fn: QualifiedName): string => names.name(fn),
  });
}

/** An id per names object, for the bind cache key (a prompt's names are one object). */
const namesIds = new WeakMap<FnNameSpelling, number>();
let nextNamesId = 0;
function namesId(names: FnNameSpelling | undefined): number {
  if (names === undefined) return 0;
  let id = namesIds.get(names);
  if (id === undefined) namesIds.set(names, (id = ++nextNamesId));
  return id;
}

/**
 * gin's grammar with the harness's `FnName`, bound with `(registry, names?, overrides?)`: without names a fn-name is
 * the plain text, with a prompt's names it is that prompt's codec. Binds are cached per registry version and names.
 */
const grammar = GinGrammarStatic
  .declare<{ FnName: string }>()
  .dynamic(
    (registry: Registry, names?: FnNameSpelling, overrides?: BuildSchemasOverrides) => ({
      ...grammarDefs(registry, overrides),
      // a qualified name with a prompt's names, the text as given without (code's and people's)
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- both hold a fn's name as text
      FnName: (names === undefined ? PLAIN_FN_NAME : fnNameCodec(names)) as SchemaOf<string>,
    }),
    { key: (registry, names, overrides) => `${grammarKey(registry, overrides)}|${namesId(names)}`, cacheSize: 4 },
  );

/** The args of `HarnessGrammar`'s binds. */
export type HarnessGrammarArgs = [registry: Registry, names?: FnNameSpelling | undefined, overrides?: BuildSchemasOverrides];

/** `HarnessGrammar`: results over gin's grammar and `FnName`, typed by the caller (gin's own types are too large to name). */
export interface HarnessModule {
  /** A root over the grammar: one of its named types (`'TypeDef'`, `'Expr'`), or a schema that refers to them. */
  result<T = unknown>(root: AnySchema | 'TypeDef' | 'Expr' | 'FnName'): Bundle<T, HarnessGrammarArgs>;
}

export const HarnessGrammar: HarnessModule = {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the root's code type is the caller's (gin's GinShapes for its own names)
  result: <T>(root: AnySchema | string) => grammar.result(root as never) as unknown as Bundle<T, HarnessGrammarArgs>,
};

/** How a gin type becomes a value schema. */
export interface GinAOptions {
  /** The scope its type names resolve in (a fn's signature: the catalog's stored types). */
  readonly scope?: TypeScope | undefined;
  /** Field docs as descriptions (`'all'`, what a model is shown) or none (a value check). */
  readonly includeDocs?: 'none' | 'type' | 'all';
  /** `'refuse'` closes every object (an agent's call, authored against the type). */
  readonly unknownKeys?: 'strip' | 'refuse';
}

/** A fn-name text as the grammar's `FnName`; every other type as gin maps it. */
const fnNameRef = (type: Type): AnySchema | undefined => (isFnNameType(type) ? a.ref('FnName') : undefined);

/** A gin type's value schema in `HarnessGrammar` (its fn-name texts are `FnName`). */
export function ginA(type: Type, opts: GinAOptions = {}): AnySchema {
  return type.toA({
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    ...(opts.includeDocs === undefined ? {} : { includeDocs: opts.includeDocs }),
    ...(opts.unknownKeys === undefined ? {} : { unknownKeys: opts.unknownKeys }),
    override: fnNameRef,
  });
}

/** A gin type's value as a bundle over `HarnessGrammar`, to bind with `(type.registry, names?)`. */
export function ginBundle<T = unknown>(type: Type, opts: GinAOptions = {}): Bundle<T, HarnessGrammarArgs> {
  return HarnessGrammar.result<T>(ginA(type, opts));
}

/** The checking bundles of types checked without a scope, by type and options (a type's value schema never changes). */
const checks = new WeakMap<Type, Map<string, Bundle<unknown, HarnessGrammarArgs>>>();
/** The same, for types checked in a scope (the bundle is per scope). */
const scoped = new WeakMap<TypeScope, WeakMap<Type, Map<string, Bundle<unknown, HarnessGrammarArgs>>>>();

/** The bundle a value of a gin type is checked with (no docs), kept per type, scope and options. */
function checkBundle(type: Type, opts: GinAOptions): Bundle<unknown, HarnessGrammarArgs> {
  const key = opts.unknownKeys ?? 'strip';
  let byType = checks;
  if (opts.scope !== undefined) {
    byType = scoped.get(opts.scope) ?? new WeakMap();
    scoped.set(opts.scope, byType);
  }
  const byKey = byType.get(type) ?? new Map<string, Bundle<unknown, HarnessGrammarArgs>>();
  byType.set(type, byKey);
  const known = byKey.get(key);
  if (known !== undefined) return known;
  const made = ginBundle(type, { ...opts, includeDocs: 'none' });
  byKey.set(key, made);
  return made;
}

/** A gin type's value check bound for code (fn-name fields plain): render it `LENIENT`, the code shape, to check. */
export function ginValueCheck<T = unknown>(type: Type, opts: GinAOptions = {}): Bound<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed by the caller, as the gin type's values
  return checkBundle(type, opts).bind(type.registry) as Bound<T>;
}

/** One problem of a value that doesn't fit a gin type: where (a dotted path, `''` for the whole) and what. */
export interface ValueProblem {
  readonly path: string;
  readonly message: string;
}

/** The dotted path of a code path (`rows.2.id`). */
export function dottedPath(path: Issue['codePath']): string {
  return path.map(String).join('.');
}

/** What checking a value against a gin type found: the value in the code shape, or its problems and the message. */
export type GinCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly ValueProblem[]; readonly message: string };

/** How `checkGinValue` checks. */
export interface GinCheckOptions extends GinAOptions {
  /** Read an object or list sent as a string holding its JSON as that JSON (default `true`); `false` keeps the value as given. */
  readonly repair?: boolean;
  /** What the message calls the value (`the args of fs/read`); default "your answer". */
  readonly label?: string;
}

/**
 * Check a value against a gin type, as code holds it (`LENIENT`): the value (repaired where an object or list came as
 * a string holding its JSON), or every problem at its dotted path and `@aeye/schema`'s message. Copies on write, so
 * the value given is never changed.
 */
export function checkGinValue<T = unknown>(type: Type, value: unknown, opts: GinCheckOptions = {}): GinCheck<T> {
  const parsed = ginValueCheck<T>(type, opts).render(LENIENT).parse(value, {
    inPlace: false,
    ...(opts.repair === undefined ? {} : { repair: opts.repair }),
    ...(opts.label === undefined ? {} : { label: opts.label }),
  });
  if (parsed.ok) return { ok: true, value: parsed.value };
  return { ok: false, problems: parsed.issues.map((issue) => ({ path: dottedPath(issue.codePath), message: issue.message })), message: parsed.message };
}
