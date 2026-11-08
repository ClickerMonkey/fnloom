/**
 * The browser's named gin types, so forms check values with gin itself. A fn's args or a handler's answer often name
 * a system's types (`fs/Entry`) or the hub's (`hub/LongText`); the hub serves their definitions with every named type
 * they reference, dependencies first (the `types` endpoint, gin `typeClosure`). `TypeLibrary` loads what a definition
 * needs, binds it into a gin scope, and gives the form gin's value schema (`toValueSchema`), whose issues name the
 * field that is wrong. Types built into this process (the hub contract registered in `g`) need no fetch.
 */
import { typeClosure, type LocalScope, type Type, type TypeDef } from '@aeye/gin';
import { isGinTypeDef, QualifiedName, type GinTypeDef, type TypeDefinitions } from '@harness/core';
import { g } from '@harness/sdk';
import type { InjectionKey } from 'vue';
import { z } from 'zod';

/** Fetch named type definitions and everything they reference from the hub. */
export type FetchTypes = (names: readonly QualifiedName[]) => Promise<TypeDefinitions>;

/** One issue of gin's value schema, as the form reads it (zod's issue, read through this schema, not trusted). */
const Issue = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number(), z.symbol()])),
  message: z.string(),
  origin: z.string().optional(),
  expected: z.string().optional(),
  minimum: z.union([z.number(), z.bigint()]).optional(),
  maximum: z.union([z.number(), z.bigint()]).optional(),
});
export type Issue = z.infer<typeof Issue>;

/** What a value schema answers: the issues, empty when the value fits. */
export type ValueCheck = (value: unknown) => readonly Issue[];

/** Where a form finds named types and gin's check of a value. */
export interface TypeSource {
  /** The definition of a named type this browser holds (from the hub, or built into `g`). */
  definition(name: string): GinTypeDef | undefined;
  /** Load every named type the definitions refer to that isn't held yet; true when something new was loaded. */
  need(defs: readonly unknown[]): Promise<boolean>;
  /**
   * The live gin type for a definition, with every named type this browser holds bound (one it doesn't hold stays a
   * lazy, unresolved reference); undefined when it isn't a definition gin can parse.
   */
  type(def: unknown): Type | undefined;
  /** gin's check for a definition, with its named types bound; undefined when one is unknown or it doesn't parse. */
  checker(def: unknown): ValueCheck | undefined;
}

/** The named types held in this browser: fetched from the hub as forms need them. */
export class TypeLibrary implements TypeSource {
  readonly #fetch: FetchTypes | undefined;
  readonly #defs = new Map<string, GinTypeDef>();
  /** Names the hub said it doesn't know, so they aren't asked for again. */
  readonly #missing = new Set<string>();

  /** With no `fetch`, only the types built into `g` are known. */
  constructor(fetch?: FetchTypes) {
    this.#fetch = fetch;
  }

  definition(name: string): GinTypeDef | undefined {
    const fetched = this.#defs.get(name);
    if (fetched !== undefined) { return fetched; }
    const built = g.lookup(name)?.toDefinitionJSON();
    return built !== undefined && isGinTypeDef(built) ? built : undefined;
  }

  async need(defs: readonly unknown[]): Promise<boolean> {
    const roots = defs.filter(isGinTypeDef);
    if (this.#fetch === undefined || roots.length === 0) { return false; }
    const closure = this.#closure(roots);
    const wanted = closure.missing.filter((name) => !this.#missing.has(name)).flatMap((name) => {
      const parsed = QualifiedName.safeParse(name);
      return parsed.success ? [parsed.data] : [];
    });
    if (wanted.length === 0) { return false; }
    const found = await this.#fetch(wanted);
    for (const record of found.types) { this.#defs.set(record.name, record.def); }
    for (const name of found.missing) { this.#missing.add(name); }
    return found.types.length > 0;
  }

  type(def: unknown): Type | undefined {
    return this.#parse(def)?.type;
  }

  checker(def: unknown): ValueCheck | undefined {
    const parsed = this.#parse(def);
    if (parsed === undefined || !parsed.complete) { return undefined; }
    try {
      const schema = parsed.type.toValueSchema({ scope: parsed.scope });
      return (value) => {
        const result = schema.safeParse(value);
        return result.success ? [] : z.array(Issue).catch([]).parse(result.error.issues);
      };
    } catch (error) {
      console.warn('chat.form.unchecked', { error });
      return undefined;
    }
  }

  /** Parse a definition in a scope with the named types it needs bound; whether every one of them was known. */
  #parse(def: unknown): { readonly type: Type; readonly scope: LocalScope; readonly complete: boolean } | undefined {
    if (!isGinTypeDef(def)) { return undefined; }
    try {
      const closure = this.#closure([def]);
      const scope = g.scope();
      for (const name of closure.order) {
        const bound = closure.defs.get(name);
        if (bound !== undefined) { scope.bind(name, scope.parse(bound)); }
      }
      return { type: scope.parse(def), scope, complete: closure.missing.length === 0 };
    } catch (error) {
      console.warn('chat.form.unreadable', { name: def.name, error });
      return undefined;
    }
  }

  /** The named types the roots need, transitively, through what this library holds. */
  #closure(roots: readonly TypeDef[]): ReturnType<typeof typeClosure> {
    return typeClosure(roots, g, (name) => this.definition(name));
  }
}

/** Where forms find the browser's type library; without one they know only the types built into `g`. */
export const GIN_TYPES: InjectionKey<TypeSource> = Symbol('harness.formTypes');

/** The library forms use when none is provided: the types built into `g`. */
export const LOCAL_TYPES: TypeSource = new TypeLibrary();
