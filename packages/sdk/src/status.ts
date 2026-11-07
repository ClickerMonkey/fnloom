/**
 * Status words, typed: a fn's status templates (core's `StatusTemplates`) checked against its args and result at
 * compile time, so `{args.path}` must be a path its args have, `{output.x}` appears only in the done phase and must be
 * a path of its result, and a `many` form names only `{fn}` and `{n}`. The hub fills them in (core `resolveStatus`).
 */
import type { RunPhase, StatusTemplates } from '@harness/core';

/** How deep a status token may reach into args or a result. */
type MaxDepth = 4;

/**
 * The dotted paths into a value (`path`, `range.start`, `items.0`). A value whose keys are open (JSON, records) allows
 * any path below it; dates and other non-plain objects stop the walk.
 */
export type PathsOf<T, Depth extends readonly unknown[] = []> =
  Depth['length'] extends MaxDepth ? never
    : T extends Date | ((...args: never[]) => unknown) ? never
    : T extends readonly (infer Item)[] ? `${number}` | `${number}.${PathsOf<Item, [...Depth, unknown]>}`
    : T extends object
      ? string extends keyof T ? string
      : { [K in keyof T & string]-?: K | `${K}.${PathsOf<NonNullable<T[K]>, [...Depth, unknown]>}` }[keyof T & string]
    : never;

/** The token names a template uses: `'{fn} read {args.path|a file}'` → `'fn' | 'args.path'`. */
export type TokensOf<S extends string> = S extends `${string}{${infer Token}}${infer Rest}`
  ? (Token extends `${infer Name}|${string}` ? Name : Token) | TokensOf<Rest>
  : never;

/** The tokens a phase's `one` form may use. */
export type OneTokens<A, R, Phase extends RunPhase> =
  | 'fn' | 'args' | `args.${PathsOf<A>}`
  | (Phase extends 'done' ? 'output' | `output.${PathsOf<R>}` : never);

/** The tokens every `many` form may use. */
export type ManyTokens = 'fn' | 'n';

/** A template as written, or an error naming the token it may not use. */
export type CheckedTemplate<S extends string, Allowed extends string> =
  [Exclude<TokensOf<S>, Allowed>] extends [never] ? S : `Unknown status token {${Exclude<TokensOf<S>, Allowed>}}`;

/** Status templates checked against a fn's args `A` and result `R`. */
export type CheckedStatus<A, R, T extends StatusTemplates> = {
  readonly [Phase in RunPhase]: {
    readonly one: CheckedTemplate<T[Phase]['one'], OneTokens<A, R, Phase>>;
    readonly many: CheckedTemplate<T[Phase]['many'], ManyTokens>;
  };
};

/** What a fn's `status` option takes: the templates as written, checked against its args and result. */
export type StatusInput<A, R, T extends StatusTemplates> = T & CheckedStatus<A, R, T>;
