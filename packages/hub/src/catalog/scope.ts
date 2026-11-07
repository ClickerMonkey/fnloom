/**
 * Parsing wire type definitions as real gin types, with the named types they refer to bound first. A definition that
 * names `fs/Entry` only means something where that name resolves, so the hub works out the closure of named types a
 * definition needs (gin `typeClosure`), binds them in dependency order into a gin scope overlay, then parses. The
 * overlay keeps every name a reference (`{ name }`), so nothing the hub parses is registered process-wide.
 */
import { createRegistry, typeClosure, typeReferences, type LocalScope, type Registry, type Type, type TypeDef } from '@aeye/gin';
import type { GinTypeDef } from '@harness/core';
import { toGin, ginName, hubName } from './names.ts';

/** Looks up the definition of a named type by its hub name (`fs/Entry`), or undefined when none is known. */
export type TypeLookup = (name: string) => GinTypeDef | undefined;

/** Definitions parsed together in one scope. */
export interface ParsedTypes {
  /** The parsed types, in the order given. */
  readonly types: readonly Type[];
  /** The scope they were parsed in: pass it to `toValueSchema` and `compatible`. */
  readonly scope: LocalScope;
  /** Named types the definitions refer to that `lookup` did not know (hub names). */
  readonly missing: readonly string[];
}

/** The error message of anything thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses wire definitions in scopes built from the named types they need. */
export class GinScopes {
  readonly registry: Registry;

  constructor(registry: Registry = createRegistry()) {
    this.registry = registry;
  }

  /** Parse several definitions in one scope holding every named type any of them needs. Throws when one is invalid. */
  parse(defs: readonly GinTypeDef[], lookup: TypeLookup): ParsedTypes {
    const roots = defs.map(toGin);
    const resolve = (name: string): TypeDef | undefined => {
      const def = lookup(hubName(name));
      return def === undefined ? undefined : toGin(def);
    };
    const closure = typeClosure(roots, this.registry, resolve);
    const scope = this.registry.scope();
    for (const name of closure.order) {
      const def = closure.defs.get(name);
      if (def !== undefined) { scope.bind(name, scope.parse(def)); }
    }
    return { types: roots.map((root) => scope.parse(root)), scope, missing: closure.missing.map(hubName) };
  }

  /** Parse one definition; see `parse`. */
  one(def: GinTypeDef, lookup: TypeLookup): { type: Type; scope: LocalScope; missing: readonly string[] } {
    const parsed = this.parse([def], lookup);
    const [type] = parsed.types;
    if (type === undefined) { throw new Error('gin returned no type'); }
    return { type, scope: parsed.scope, missing: parsed.missing };
  }

  /** What is wrong with definitions, empty when each parses and every named type it needs is known. */
  problems(defs: readonly GinTypeDef[], lookup: TypeLookup): string[] {
    try {
      return this.parse(defs, lookup).missing.map((name) => `refers to the unknown type ${name}`);
    } catch (error) {
      return [messageOf(error)];
    }
  }

  /** The named types a definition refers to and does not define itself (hub names). */
  references(def: GinTypeDef): string[] {
    return typeReferences(toGin(def), this.registry).refs.map(hubName);
  }

  /** Every named type a definition mentions: those it refers to and those it carries inline (hub names). */
  mentions(def: GinTypeDef): string[] {
    const found = typeReferences(toGin(def), this.registry);
    return [...new Set([...found.refs, ...found.defines])].map(hubName);
  }

  /** The named types `names` depend on, transitively, dependencies first, and the ones `lookup` did not know. */
  closure(names: readonly string[], lookup: TypeLookup): { order: string[]; missing: string[] } {
    const roots: TypeDef[] = names.map((name) => ({ name: ginName(name) }));
    const resolve = (name: string): TypeDef | undefined => {
      const def = lookup(hubName(name));
      return def === undefined ? undefined : toGin(def);
    };
    const closure = typeClosure(roots, this.registry, resolve);
    return { order: closure.order.map(hubName), missing: closure.missing.map(hubName) };
  }
}
