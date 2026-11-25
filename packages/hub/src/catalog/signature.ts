/**
 * A fn's signature as `@aeye/schema` (`a`) schemas: the one value check every caller of a fn's args uses (a run's
 * args, a policy's, a claim's, a static `run` call), the schema a model is shown for them (bound per prompt, so its
 * fn-name fields are that prompt's spelling), the JSON schema forms and MCP clients read, and the returns a model's
 * structured answer is asked in. Built once per fn version (`StoreCatalog.signature`).
 */
import type { Type, TypeScope } from '@aeye/gin';
import { LENIENT, type Bindable, type Bound, type Bundle } from '@aeye/schema';
import { checkGinValue, ginBundle, type FnNameSpelling, type GinCheck, type HarnessGrammarArgs, type Json, type QualifiedName } from '@harness/core';
import type { FnSignature } from './index.ts';

/**
 * A signature of gin types parsed in a scope (the catalog's stored types; none for a fn whose types are all built in).
 * Unknown keys in the args are refused (an agent's call is authored against them); `strip` drops them (test rigs).
 */
export function fnSignature(fn: QualifiedName, args: Type, returns: Type, scope?: TypeScope, unknownKeys: 'refuse' | 'strip' = 'refuse'): FnSignature {
  const at = scope === undefined ? {} : { scope };
  const model: Bundle<object, HarnessGrammarArgs> = ginBundle<object>(args, { ...at, includeDocs: 'all', unknownKeys });
  const output: Bundle<unknown, HarnessGrammarArgs> = ginBundle(returns, { ...at, includeDocs: 'all' });
  let jsonSchema: Record<string, unknown> | undefined;
  return {
    fn, args, returns, ...at,
    check: (value: unknown): GinCheck<Json> => checkGinValue<Json>(args, value, { ...at, unknownKeys }),
    argsFor: (names?: FnNameSpelling): Bound<object> => model.bind(args.registry, names),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed by the caller, as the gin type's values
    returnsFor: <T>(names?: FnNameSpelling): Bound<T> => output.bind(returns.registry, names) as Bound<T>,
    // the code shape (`LENIENT`): what a person's form and an MCP client write
    get argsJsonSchema(): Record<string, unknown> {
      jsonSchema ??= jsonSchemaOf(model.bind(args.registry));
      return jsonSchema;
    },
  };
}

/**
 * A bound schema as an `@aeye/core` Tool's or Prompt's schema: one with nothing left to bind (a prompt's names are
 * bound already). Binding gives the same instance every time, so its renderings are made once.
 */
export function bindable<T>(bound: Bound<T>): Bindable<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `_out` and `_refs` are type-only marks
  return { bind: () => bound } as Bindable<T>;
}

/** A bound schema's JSON schema as code writes its values (`LENIENT`). */
export function jsonSchemaOf<T>(bound: Bound<T>): Record<string, unknown> {
  return bound.render(LENIENT).jsonSchema;
}

/** Whether a value is a JSON object (not null, not a list). */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a bound schema's value is an object, read off its JSON schema (a named type followed to its definition): what
 * a native tool's args must be. Bind it without a prompt's names, so the rendering is the signature's own.
 */
export function isObjectBound<T>(bound: Bound<T>): boolean {
  const schema = jsonSchemaOf(bound);
  const defs = schema['$defs'];
  let at: unknown = schema;
  for (let hops = 0; hops < 32 && isRecord(at); hops++) {
    if (at['type'] === 'object') return true;
    const ref = at['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith('#/$defs/') || !isRecord(defs)) return false;
    at = defs[ref.slice('#/$defs/'.length)];
  }
  return false;
}
