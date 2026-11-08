/**
 * The context graph over the store's `contextLinks` table. Declared and mentioned edges are rewritten from their
 * record by `writeDerivedLinks`, which the catalog calls inside the transaction that writes the record, so they never
 * drift; resource edges are replaced wholesale per item; learned edges grow with co-use and fade with time (their
 * weight is worked out from their decayed use count whenever they are read); authored edges are a person's.
 */
import { linkTargetKey, splitName, type ActorId, type ContextLink, type ContextRecord, type DeclarableRelation, type LinkTarget, type QualifiedName } from '@harness/core';
import { allRows } from '../catalog/rows.ts';
import type { Catalog } from '../catalog/index.ts';
import type { HubStore } from '../store/index.ts';
import type { ContextGraph } from './index.ts';
import { decayedUses, DERIVED_SOURCES, learnedWeight, link, linkKey, linksOf, targetName } from './links.ts';

/** Rewrite a record's derived edges on `store` (a transaction's, when the record is written in one). */
export async function writeDerivedLinks(store: HubStore, record: Pick<ContextRecord, 'name' | 'decl' | 'mentions'>, at: number): Promise<void> {
  const table = store.table('contextLinks');
  const fresh = linksOf(record, at);
  const keep = new Set(fresh.map(linkKey));
  for (const edge of await allRows(table, { from: record.name, source: { in: DERIVED_SOURCES } })) {
    if (!keep.has(linkKey(edge))) await table.remove({ from: edge.from, toKey: edge.toKey, relation: edge.relation });
  }
  for (const edge of fresh) await table.put(edge);
}

/** Remove every edge out of an item that is gone (the catalog calls this when it removes context). */
export async function removeLinksFrom(store: HubStore, from: QualifiedName): Promise<void> {
  const table = store.table('contextLinks');
  for (const edge of await allRows(table, { from })) await table.remove({ from: edge.from, toKey: edge.toKey, relation: edge.relation });
}

/** What the graph needs. */
export interface StoreContextGraphDeps {
  readonly store: HubStore;
  /** Tells context from fns when an edge is learned between two names. */
  readonly catalog: Pick<Catalog, 'context'>;
  readonly clock: () => number;
  /** A learned edge's use count halves after this long without use (ms). */
  readonly halfLife: number;
}

/** The context graph in the hub store. */
export class StoreContextGraph implements ContextGraph {
  readonly #deps: StoreContextGraphDeps;

  constructor(deps: StoreContextGraphDeps) {
    this.#deps = deps;
  }

  async links(from: QualifiedName): Promise<ContextLink[]> {
    return (await allRows(this.#deps.store.table('contextLinks'), { from })).map((edge) => this.#current(edge));
  }

  async backlinks(to: LinkTarget): Promise<ContextLink[]> {
    return (await allRows(this.#deps.store.table('contextLinks'), { toKey: linkTargetKey(to) })).map((edge) => this.#current(edge));
  }

  async neighbours(names: readonly QualifiedName[], hops: number, limit: number): Promise<ReadonlyMap<QualifiedName, number>> {
    const best = new Map<QualifiedName, number>();
    const seeds = new Set(names);
    let frontier = new Map<QualifiedName, number>(names.map((name) => [name, 1]));
    for (let hop = 0; hop < hops && frontier.size > 0; hop++) {
      const next = new Map<QualifiedName, number>();
      for (const [name, strength] of frontier) {
        for (const edge of await this.#around(name)) {
          const other = edge.from === name ? targetName(edge.to) : edge.from;
          if (other === undefined || seeds.has(other)) continue;
          const value = strength * edge.weight;
          if (value <= (best.get(other) ?? 0)) continue;
          best.set(other, value);
          next.set(other, value);
        }
      }
      frontier = next;
    }
    return new Map([...best].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit));
  }

  async derive(record: ContextRecord): Promise<void> {
    await writeDerivedLinks(this.#deps.store, record, this.#deps.clock());
  }

  async replaceResourceLinks(from: QualifiedName, links: ReadonlyArray<Pick<ContextLink, 'to' | 'relation' | 'weight'>>): Promise<void> {
    const at = this.#deps.clock();
    await this.#deps.store.tx(async (tx) => {
      const table = tx.table('contextLinks');
      for (const edge of await allRows(table, { from, source: 'resource' })) await table.remove({ from, toKey: edge.toKey, relation: edge.relation });
      for (const edge of links) await table.put(link(from, edge.to, edge.relation, edge.weight, 'resource', at));
    });
  }

  async learn(used: readonly QualifiedName[]): Promise<void> {
    const names = [...new Set(used)].sort();
    if (names.length < 2) return;
    const { store, clock, halfLife } = this.#deps;
    const at = clock();
    const targets = new Map(await Promise.all(names.map(async (name) => [name, await this.#target(name)] as const)));
    await store.tx(async (tx) => {
      const table = tx.table('contextLinks');
      for (const [i, from] of names.entries()) {
        for (const to of names.slice(i + 1)) {
          const target = targets.get(to);
          if (target === undefined) continue;
          const key = { from, toKey: linkTargetKey(target), relation: 'learned' as const };
          const known = await table.get(key);
          const uses = (known === undefined ? 0 : decayedUses(known.uses ?? 0, at - known.updatedAt, halfLife)) + 1;
          await table.put({ ...link(from, target, 'learned', learnedWeight(uses), 'learned', at), uses });
        }
      }
    });
  }

  async author(input: { from: QualifiedName; to: LinkTarget; relation: DeclarableRelation; weight: number; by: ActorId }): Promise<ContextLink> {
    return this.#deps.store.table('contextLinks').put({ ...link(input.from, input.to, input.relation, input.weight, 'authored', this.#deps.clock()), by: input.by });
  }

  remove(key: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): Promise<boolean> {
    return this.#deps.store.table('contextLinks').remove({ from: key.from, toKey: key.toKey, relation: key.relation });
  }

  /** Edges out of a name and into it (as context or as a fn). */
  async #around(name: QualifiedName): Promise<ContextLink[]> {
    const into = await Promise.all((['context', 'fn'] as const).map((kind) => this.backlinks({ kind, name })));
    return [...(await this.links(name)), ...into.flat()];
  }

  /** A learned edge's weight as of now; other edges as stored. */
  #current(edge: ContextLink): ContextLink {
    if (edge.source !== 'learned') return edge;
    return { ...edge, weight: learnedWeight(decayedUses(edge.uses ?? 0, this.#deps.clock() - edge.updatedAt, this.#deps.halfLife)) };
  }

  /** Whether a name is context or a fn, as an edge target. */
  async #target(name: QualifiedName): Promise<LinkTarget | undefined> {
    if (splitName(name).system === '') return undefined;
    return (await this.#deps.catalog.context(name)) === undefined ? { kind: 'fn', name } : { kind: 'context', name };
  }
}
