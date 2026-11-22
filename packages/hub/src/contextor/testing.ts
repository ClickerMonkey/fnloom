/**
 * Test helpers for the contextor: a seeded random generator (so random cases repeat), context records and fn records
 * made from a few fields, a catalog over them, and the contextor's services built over a test store. Tests only.
 */
import { fn, fnDecl, g, type AnyFnDef } from '@harness/sdk';
import { FnNameIndex, noFnStats, SystemName, type ManifestSection, type ContextDecl, type ContextRecord, type FnRecord, type ModelInfo, type QualifiedName, type SearchHit } from '@harness/core';
import { z } from 'zod';
import type { Catalog, CatalogEntry, FnSignature } from '../catalog/index.ts';
import type { SessionService } from '../chat/index.ts';
import type { SearchQuery } from '../index/index.ts';
import type { HubStore } from '../store/index.ts';
import { memoryLog, testStore } from '../testing.ts';
import { createContextor } from './create.ts';
import { contextorEnv, type ContextorEnv } from './env.ts';
import type { DynamicContext } from './index.ts';
import type { ProbeFactory } from './limits.ts';

/** A small fast seeded generator (mulberry32): the same seed gives the same numbers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A context record from a few fields. */
export function contextRecord(name: QualifiedName, fields: Partial<ContextDecl> & Partial<Pick<ContextRecord, 'origin' | 'disabled' | 'mentions'>> = {}): ContextRecord {
  const { origin, disabled, mentions, ...decl } = fields;
  const slash = name.indexOf('/');
  return {
    name, system: SystemName.parse(name.slice(0, slash)), stale: false, updatedAt: 0, mentions: mentions ?? { context: [], fns: [] },
    ...(origin === undefined ? {} : { origin }), ...(disabled === undefined ? {} : { disabled }),
    decl: {
      name: name.slice(slash + 1), description: `About ${name}.`, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [], ...decl,
    },
  };
}

/** A catalog over context records and fns declared in the test. */
export class ContextCatalog implements Pick<Catalog, 'fn' | 'fns' | 'context' | 'availability' | 'entries' | 'signature' | 'typeClosure' | 'type' | 'modelNames'> {
  readonly contexts = new Map<QualifiedName, ContextRecord>();
  readonly records = new Map<QualifiedName, FnRecord>();
  /** Kinds and types the test names (with the context keys, they keep their `/` in text). */
  readonly reserved = new Set<string>();
  readonly #defs = new Map<QualifiedName, AnyFnDef>();

  /** Add context. */
  addContext(record: ContextRecord): ContextRecord {
    this.contexts.set(record.name, record);
    return record;
  }

  /** Declare a fn (by default one that reads a path). */
  addFn(name: QualifiedName, def: AnyFnDef = fn({ description: `Does ${name}.`, args: g.obj({ path: g.text() }), returns: g.text() }), extra: Partial<FnRecord> = {}): FnRecord {
    const slash = name.indexOf('/');
    const record: FnRecord = {
      name, system: SystemName.parse(name.slice(0, slash)), decl: fnDecl(name.slice(slash + 1), def), version: 'v1', origin: 'contract', available: true, paused: false, disabled: false,
      stats: noFnStats(), updatedAt: 0, ...extra,
    };
    this.records.set(name, record);
    this.#defs.set(name, def);
    return record;
  }

  fn(name: QualifiedName): Promise<FnRecord | undefined> {
    return Promise.resolve(this.records.get(name));
  }

  /** The test fns' model names, the systems of its fns and context installed; no named types here. */
  modelNames(): ReturnType<Catalog['modelNames']> {
    const systems = [...this.records.values(), ...this.contexts.values()].map((record) => record.system);
    return Promise.resolve({ index: FnNameIndex.of(this.records.keys(), [], { systems, reserved: [...this.contexts.keys(), ...this.reserved] }), types: () => undefined });
  }

  fns(filter: { names?: readonly QualifiedName[] }): Promise<FnRecord[]> {
    return Promise.resolve([...this.records.values()].filter((r) => filter.names === undefined || filter.names.includes(r.name)));
  }

  context(name: QualifiedName): Promise<ContextRecord | undefined> {
    return Promise.resolve(this.contexts.get(name));
  }

  availability(name: QualifiedName): ReturnType<Catalog['availability']> {
    return Promise.resolve(this.records.get(name)?.available ?? true);
  }

  /** The context entries (the only section these tests declare). */
  entries<S extends ManifestSection>(section: S): Promise<Array<CatalogEntry<S>>> {
    const sections: { [K in ManifestSection]: Array<CatalogEntry<K>> } = {
      types: [], settings: [], attachments: [], kinds: [], fns: [], hooks: [], mentions: [], sectioners: [], actions: [],
      context: [...this.contexts.values()].map((c) => ({ name: c.name, system: c.system, decl: c.decl })),
    };
    return Promise.resolve(sections[section]);
  }

  signature(name: QualifiedName): Promise<FnSignature> {
    const def = this.#defs.get(name);
    if (def === undefined) return Promise.reject(new Error(`no fn ${name}`));
    const argsSchema = def.args.toValueSchema();
    return Promise.resolve({
      fn: name, args: def.args, returns: def.returns, argsSchema, returnsSchema: def.returns.toValueSchema(),
      argsJsonSchema: z.record(z.string(), z.unknown()).parse(z.toJSONSchema(argsSchema, { unrepresentable: 'any' })),
    });
  }

  typeClosure(names: readonly QualifiedName[]): ReturnType<Catalog['typeClosure']> {
    return Promise.resolve({ order: [], missing: [...names] });
  }

  type(): ReturnType<Catalog['type']> {
    return Promise.resolve(undefined);
  }
}

/** A search that answers from a fixed list of hits for any query (or a function of the query). */
export class FixedSearch {
  hits: SearchHit[] | ((text: string) => SearchHit[]) = [];
  readonly queries: string[] = [];

  /** The hits of the asked kinds that `keep` keeps (the hub's search asks it of each hit), up to the limit. */
  async search(query: Pick<SearchQuery, 'text' | 'limit' | 'keep'> & { readonly kinds: readonly string[] }): Promise<SearchHit[]> {
    this.queries.push(query.text);
    const hits = typeof this.hits === 'function' ? this.hits(query.text) : this.hits;
    const kept: SearchHit[] = [];
    for (const hit of hits) {
      if (kept.length >= query.limit) break;
      if (query.kinds.includes(hit.kind) && (query.keep === undefined || await query.keep(hit))) kept.push(hit);
    }
    return kept;
  }
}

/** A session loader over a store (what `SessionService.load` does to the row). */
export function sessionLoader(store: HubStore): Pick<SessionService, 'load'> {
  return {
    load: (id, loaded) => store.table('sessions').update(id, {
      ...(loaded.tools === undefined ? {} : { tools: [...loaded.tools] }), ...(loaded.context === undefined ? {} : { context: [...loaded.context] }),
    }),
  };
}

/** A chat model the fakes offer. */
export function chatModel(id: string, fields: Partial<ModelInfo> = {}): ModelInfo {
  return { id, provider: 'openrouter', name: id, contextWindow: 8_192, capabilities: ['chat', 'tools'], ...fields };
}

/** The contextor's services over a test store and a `ContextCatalog`. */
export async function contextorRig(options: { models?: ModelInfo[]; settings?: Partial<ContextorEnv>; probes?: ProbeFactory; dynamic?: DynamicContext } = {}) {
  const store = await testStore();
  const catalog = new ContextCatalog();
  const search = new FixedSearch();
  const { log, records } = memoryLog();
  const time = { now: 1_000_000 };
  const models = options.models ?? [chatModel('small', { contextWindow: 2_048 })];
  const services = createContextor({
    store, catalog, search, settings: { ...contextorEnv.parse(), ...options.settings }, modelSettings: { HARNESS_DEFAULT_MODEL: 'small' },
    models: () => Promise.resolve(models), log, clock: () => time.now, probes: options.probes ?? (() => undefined),
    ...(options.dynamic === undefined ? {} : { dynamic: options.dynamic }),
  });
  return { store, catalog, search, log, records, time, models, ...services };
}
