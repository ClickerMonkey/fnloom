/**
 * Parallel claims, typed: a fn's claim templates (core's `FnDecl.parallelClaims`) checked against its args at compile
 * time, so `{args.path}` must be a path its args have. The hub fills them in from each call's args (core
 * `fillClaims`); a fn that declares `dynamicClaims` also has its implementation's `claims(args, ctx)` asked. The rule
 * that turns claims into an order is aeye's (`claimsConflict`, `claimWaits`); its claims type is re-exported here, its values
 * (`ALL_CLAIMS`) from `@harness/sdk/server`.
 */
import type { PathsOf, TokensOf } from './status.ts';

export type { ToolClaims } from '@aeye/core';

/** The tokens a claim template may use: a path into its fn's args. */
export type ClaimTokens<A> = `args.${PathsOf<A>}`;

/** A claim template as written, or an error naming the token it may not use. */
export type CheckedClaim<S extends string, A> =
  [Exclude<TokensOf<S>, ClaimTokens<A>>] extends [never] ? S : `Unknown claim token {${Exclude<TokensOf<S>, ClaimTokens<A>>}}`;

/** What a fn's `parallelClaims` option takes: the templates as written, each checked against its args. */
export type ClaimsInput<A, C extends readonly string[]> = C & { readonly [K in keyof C]: C[K] extends string ? CheckedClaim<C[K], A> : C[K] };
