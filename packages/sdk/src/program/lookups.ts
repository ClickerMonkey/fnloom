/**
 * Where a program's fns and named types come from, in each place a program kind meets one: an authoring run (the
 * hub's search, `hub/fns_get` as a dep and `ctx.types`), a kind's check and describe (`KindCheckCtx`), and a kind's run
 * (`ctx.types` and `hub/fns_get` as one of the deps its `describe` gave).
 */
import type { TypeDef } from '@aeye/gin';
import { Json, strongerMode, type FnMode, type FnSearchPage, type FnSearchQuery, type QualifiedName, type TypeDefinitions } from '@harness/core';
import { CallFailed, type FnCall } from '../ctx.ts';
import type { KindCheckCtx } from '../declare.ts';
import { parseValue } from '../gin.ts';
import { hub } from '../hub.ts';
import { typeClosure, type ProgramFn, type ProgramLookups } from './runtime.ts';
import { modeOf, type ProgramHost } from './tools.ts';

/** A fn as `hub/fns_get` declares it: what a program needs of a callee. */
export interface DeclaredFn {
  readonly description: string;
  readonly args?: TypeDef | undefined;
  readonly returns?: TypeDef | undefined;
}

/** What an authoring run reaches the hub through: its search, its types and `hub/fns_get` (a dep of the fn). */
export interface AuthoringHub {
  searchFns(query: FnSearchQuery): Promise<FnSearchPage>;
  readonly types: { definitions(names: readonly QualifiedName[]): Promise<TypeDefinitions> };
}

/** The program host of an authoring run: fns by the hub's search, each fn's signature and mode, named types. */
export function hubProgramHost(run: AuthoringHub, getFn: (name: QualifiedName) => Promise<DeclaredFn>): ProgramHost {
  return {
    search: (query) => run.searchFns(query),
    async fn(name) {
      const [declared, page] = await Promise.all([getFn(name), run.searchFns({ names: [name], items: ['fn'], available: false })]);
      if (declared.args === undefined || declared.returns === undefined) throw new Error(`The hub gave no signature for ${name}.`);
      return { name, description: declared.description, args: declared.args, returns: declared.returns, mode: modeOf(page, name) };
    },
    types: (names) => run.types.definitions(names),
  };
}

/** A kind's check and describe: types and fns as the hub declares them to the system. */
export function kindCheckLookups(ctx: KindCheckCtx): ProgramLookups {
  return {
    types: (names) => typeClosure(names, (name) => ctx.type(name)),
    async fn(name): Promise<ProgramFn | undefined> {
      const shape = await ctx.fn(name);
      return shape === undefined ? undefined : { name, description: shape.description, args: shape.args, returns: shape.returns, mode: shape.mode };
    },
  };
}

/** What a kind's run reaches: named types, and calls by name (`hub/fns_get` must be among its described deps). */
export interface KindRunHub {
  readonly types: { definitions(names: readonly QualifiedName[]): Promise<TypeDefinitions> };
  call(fn: QualifiedName, args: Json): FnCall<Json>;
}

/** A kind's run: types from `ctx.types`, each callee's signature from `hub/fns_get`. */
export function kindRunLookups(ctx: KindRunHub): ProgramLookups {
  return {
    types: (names) => ctx.types.definitions(names),
    async fn(name): Promise<ProgramFn | undefined> {
      try {
        const stored = parseValue(hub.fns.fns_get.returns, await ctx.call(hub.fns.fns_get.name, Json.parse({ fn: name })));
        if (stored.args === undefined || stored.returns === undefined) return undefined;
        return { name, description: stored.description, args: stored.args, returns: stored.returns };
      } catch (error) {
        if (error instanceof CallFailed) return undefined;
        throw error;
      }
    },
  };
}

/**
 * The strongest mode of the fns a program calls, for its kind's `describe` to declare: a callee the lookups don't
 * know, or whose mode they don't give, counts as a write.
 */
export async function calleesMode(calls: readonly QualifiedName[], lookups: ProgramLookups): Promise<FnMode> {
  const modes = await Promise.all(calls.map(async (name) => (await lookups.fn(name))?.mode ?? 'write'));
  return modes.reduce<FnMode>(strongerMode, 'read');
}
