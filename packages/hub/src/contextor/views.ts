/**
 * Fns as modes show them (`FnView`): the record, its parsed signature, the signature as gin's TypeScript-like code
 * (`args.toCode()`, `returns.toCode()`), and the definition of each named type it uses, dependencies first. Built
 * once per fn version. Whether a session may use a fn (switched on, available, a system the session uses) is
 * answered here too, so every mode and contextor asks the same question the same way.
 */
import { effectsLine, RESULT_TABLE_ROUTING, type Audience, type FnBlock, type FnRefusal, type FnRecord, type QualifiedName, type RegistryEffect, type Session, type TypeRecord } from '@harness/core';
import { returnsTable } from '@harness/sdk';
import type { AccessScope } from '../access/index.ts';
import type { Catalog } from '../catalog/index.ts';
import { GinScopes } from '../catalog/scope.ts';
import { allowsSystem } from '../chat/support.ts';
import type { FnView, FnViewSource } from './index.ts';

/** Whether a session (or an agent outside one) may use a fn now, for a person who may see it. */
export function usable(record: FnRecord, session: Pick<Session, 'systems'> | undefined, access: AccessScope): boolean {
  return !record.disabled && record.available === true && (session === undefined || allowsSystem(session, record.system)) && access.mayUse(record);
}

/** Whether an audience (a fn's `visibility`, a context item's `suggest`) includes the model. */
export function forModel(audience: Audience): boolean {
  return audience === 'llm' || audience === 'both';
}

/**
 * Whether the model may run a fn by name (static `run`, `load`, `inspect`): usable here, and meant for the model. A fn
 * of visibility `none` (the hub's own, such as `web/fetch_raw`) or `user` is never run for the model, whatever it names.
 */
export function modelMayUse(record: FnRecord, session: Pick<Session, 'systems'> | undefined, access: AccessScope): boolean {
  return usable(record, session, access) && forModel(record.decl.visibility);
}

/**
 * What blocks the model from loading or running a fn by name, or undefined when nothing does: the one check
 * `hub/load`, `hub/load_fns`, `hub/load_context`, the static `run`, `inspect` and the prompt's context blocks share.
 * An unavailable fn says why in the hub's own words (its availability's `detail`, "database/create_table changed and
 * waits for an admin to approve it"), never a bare "unavailable". A fn the person can't see reads as missing.
 */
export function fnRefusal(record: FnRecord | undefined, session: Pick<Session, 'systems'> | undefined, access: AccessScope): FnBlock | undefined {
  if (record === undefined || !access.seesFn(record)) return { code: 'no-such-fn', reason: 'no such fn' };
  if (modelMayUse(record, session, access)) return undefined;
  const { system } = record;
  if (record.disabled) return { code: 'disabled', reason: `${record.name} is switched off`, system };
  if (session !== undefined && !allowsSystem(session, system)) return { code: 'other-system', reason: `this session does not use ${system}`, system };
  if (!forModel(record.decl.visibility)) return { code: 'not-for-model', reason: 'not for the model', system };
  // every other check passed above, so one of these two is what blocks it
  return unavailableBlock(record, access) ?? { code: 'connect-account', reason: 'connect your account to use this fn', system };
}

/**
 * What blocks a fn the person can see from being used now, whoever asks (the model or the web's search): its
 * availability, in the hub's words, else an account to connect; undefined when it can be used.
 */
export function unavailableBlock(record: FnRecord, access: Pick<AccessScope, 'mayUse'>): FnBlock | undefined {
  if (record.available !== true) return { code: record.available.unavailable, reason: record.available.detail, system: record.system };
  if (!access.mayUse(record)) return { code: 'connect-account', reason: 'connect your account to use this fn', system: record.system };
  return undefined;
}

/**
 * Whether a block reads as "no such fn" where the model didn't name the fn itself (a context's brought fns, a static
 * `run` of a guessed name): one the person can't see, or one never meant for the model, is not announced.
 */
export function readsAsMissing(block: Pick<FnBlock, 'code'>): boolean {
  return block.code === 'no-such-fn' || block.code === 'not-for-model';
}

/** A refusal of a fn by the name it was asked for. */
export function refusalOf(fn: string, block: FnBlock): FnRefusal {
  return { fn, ...block };
}

/** A named type's definition as a card shows it. */
export function typeDefinition(name: QualifiedName, record: Pick<TypeRecord, 'description'>, code: string): string {
  const doc = record.description.trim() === '' ? '' : `// ${record.description.split('\n', 1)[0]}\n`;
  return `${doc}type ${name} = ${code}`;
}

/** What fns change in the hub, worked out deeply (`FnFactsService.registry`). */
export type RegistrySource = (fns: readonly QualifiedName[]) => Promise<ReadonlyMap<QualifiedName, readonly RegistryEffect[]>>;

/** What long-running fns warn of (`FnFactsService.notices`). */
export type NoticeSource = (fns: readonly QualifiedName[]) => Promise<ReadonlyMap<QualifiedName, string>>;

/** Where the lines beside a view's description come from; each one left out leaves its line out. */
export interface FnViewLines {
  readonly registry?: RegistrySource;
  readonly notices?: NoticeSource;
}

/** Fn views over the catalog. */
export class CatalogFnViews implements FnViewSource {
  readonly #catalog: Pick<Catalog, 'fn' | 'signature' | 'typeClosure' | 'type'>;
  readonly #scopes: GinScopes;
  readonly #lines: FnViewLines;
  readonly #cache = new Map<QualifiedName, { readonly version: string; readonly view: FnView }>();

  /** With `lines.registry`, each view carries the line saying what its fn changes in the hub; with `lines.notices`, its long-running warning. */
  constructor(catalog: Pick<Catalog, 'fn' | 'signature' | 'typeClosure' | 'type'>, scopes: GinScopes = new GinScopes(), lines: FnViewLines = {}) {
    this.#catalog = catalog;
    this.#scopes = scopes;
    this.#lines = lines;
  }

  async view(name: QualifiedName): Promise<FnView | undefined> {
    const record = await this.#catalog.fn(name);
    if (record === undefined) return undefined;
    // the parts made from the declaration are kept per version; the record itself (switched off, available) is always fresh
    // what it changes and how long it runs are read fresh too: they follow the fns it uses and its runs
    const effects = await this.#effects(name);
    const cached = this.#cache.get(name);
    if (cached?.version === record.version) return { ...cached.view, record, ...effects };
    const signature = await this.#catalog.signature(name);
    const view: FnView = {
      record, signature, args: signature.args.toCode(), returns: signature.returns.toCode(), types: await this.#types(record),
      // a fn that returns a table is drawn for the person: its line says so
      ...(returnsTable(record.decl.returns) ? { routing: RESULT_TABLE_ROUTING } : {}),
    };
    this.#cache.set(name, { version: record.version, view });
    return { ...view, ...effects };
  }

  /** The view's effects line, when the fn changes anything in the hub, and its warning, when it usually runs long. */
  async #effects(name: QualifiedName): Promise<Pick<FnView, 'effects' | 'notice'>> {
    const { registry, notices } = this.#lines;
    const [effects, notice] = await Promise.all([
      registry === undefined ? undefined : registry([name]).then((found) => effectsLine(found.get(name) ?? [])),
      notices === undefined ? undefined : notices([name]).then((found) => found.get(name)),
    ]);
    return { ...(effects === undefined ? {} : { effects }), ...(notice === undefined ? {} : { notice }) };
  }

  async typeText(name: QualifiedName): Promise<string | undefined> {
    const types = await this.#definitions([name]);
    return types.has(name) ? [...types.values()].join('\n') : undefined;
  }

  /** The named types a fn's signature uses, each with its definition, dependencies first. */
  #types(record: FnRecord): Promise<ReadonlyMap<QualifiedName, string>> {
    return this.#definitions([...new Set([...this.#references(record.decl.args), ...this.#references(record.decl.returns)])]);
  }

  /** The definitions of named types and every type they use, dependencies first; a type that no longer parses is left out. */
  async #definitions(refs: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, string>> {
    if (refs.length === 0) return new Map();
    const closure = await this.#catalog.typeClosure(refs);
    const records = new Map<string, TypeRecord>();
    for (const name of closure.order) {
      const type = await this.#catalog.type(name);
      if (type !== undefined) records.set(type.name, type);
    }
    const lookup = (name: string): TypeRecord['def'] | undefined => records.get(name)?.def;
    const types = new Map<QualifiedName, string>();
    for (const type of records.values()) {
      try {
        types.set(type.name, typeDefinition(type.name, type, this.#scopes.one(type.def, lookup).type.toCode()));
      } catch {
        // a type that no longer parses is left off the card; its name still shows in the signature
      }
    }
    return types;
  }

  #references(def: FnRecord['decl']['args']): QualifiedName[] {
    try {
      return this.#scopes.references(def);
    } catch {
      return [];
    }
  }
}
