/**
 * The edges a context record makes by itself, and how learned edges grow and fade. `linksOf` is the one source of
 * truth for declared and mentioned edges: `imports` → imports (1), `fns` → brings (1), `suggestFns` → suggests (0.5),
 * `parent` / `next` → 0.6, `links` as declared, and references found in the text → mentions (0.4). Learned edges
 * count the turns that used both ends: `weight = 0.6 · (1 − e^(−n/4))`, so one never outweighs a declared edge, and
 * the count halves every half-life without use.
 */
import { linkTargetKey, type ContextLink, type ContextRecord, type LinkRelation, type LinkSource, type LinkTarget, type QualifiedName } from '@harness/core';

/** The weight of each relation a record field makes. */
export const DERIVED_WEIGHTS = { imports: 1, brings: 1, suggests: 0.5, parent: 0.6, next: 0.6, mentions: 0.4 } as const satisfies Partial<Record<LinkRelation, number>>;

/** The sources `linksOf` makes, rewritten whenever the record is. */
export const DERIVED_SOURCES = ['declared', 'mentioned'] as const satisfies readonly LinkSource[];

/** The most a learned edge weighs. */
export const LEARNED_MAX = 0.6;

/** A learned edge's weight after `uses` turns used both ends. */
export function learnedWeight(uses: number): number {
  return LEARNED_MAX * (1 - Math.exp(-Math.max(0, uses) / 4));
}

/** A learned edge's use count after `elapsed` ms without use. */
export function decayedUses(uses: number, elapsed: number, halfLife: number): number {
  return elapsed <= 0 ? uses : uses * 0.5 ** (elapsed / halfLife);
}

/** An edge, keyed. */
export function link(from: QualifiedName, to: LinkTarget, relation: LinkRelation, weight: number, source: LinkSource, at: number): ContextLink {
  return { from, to, toKey: linkTargetKey(to), relation, weight: Math.min(1, Math.max(0, weight)), source, updatedAt: at };
}

/** The stored key of an edge. */
export function linkKey(edge: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): string {
  return `${edge.from}\u0000${edge.toKey}\u0000${edge.relation}`;
}

/** Every edge a record's own fields make, one per key (the strongest when a field repeats one). */
export function linksOf(record: Pick<ContextRecord, 'name' | 'decl' | 'mentions'>, at: number): ContextLink[] {
  const { name, decl } = record;
  const context = (to: QualifiedName): LinkTarget => ({ kind: 'context', name: to });
  const fn = (to: QualifiedName): LinkTarget => ({ kind: 'fn', name: to });
  const edges: ContextLink[] = [
    ...decl.imports.map((to) => link(name, context(to), 'imports', DERIVED_WEIGHTS.imports, 'declared', at)),
    ...decl.fns.map((to) => link(name, fn(to), 'brings', DERIVED_WEIGHTS.brings, 'declared', at)),
    ...decl.suggestFns.map((to) => link(name, fn(to), 'suggests', DERIVED_WEIGHTS.suggests, 'declared', at)),
    ...(decl.parent === undefined ? [] : [link(name, context(decl.parent), 'parent', DERIVED_WEIGHTS.parent, 'declared', at)]),
    ...(decl.next === undefined ? [] : [link(name, context(decl.next), 'next', DERIVED_WEIGHTS.next, 'declared', at)]),
    ...(decl.links ?? []).map((declared) => link(name, declared.to, declared.relation, declared.weight, 'declared', at)),
    ...record.mentions.context.map((to) => link(name, context(to), 'mentions', DERIVED_WEIGHTS.mentions, 'mentioned', at)),
    ...record.mentions.fns.map((to) => link(name, fn(to), 'mentions', DERIVED_WEIGHTS.mentions, 'mentioned', at)),
  ];
  const strongest = new Map<string, ContextLink>();
  for (const edge of edges) {
    if (edge.toKey === linkTargetKey(context(name))) continue;
    const key = linkKey(edge);
    const known = strongest.get(key);
    if (known === undefined || edge.weight > known.weight) strongest.set(key, edge);
  }
  return [...strongest.values()];
}

/** The name an edge points at, for edges between items (context, fns, types); resources have none. */
export function targetName(to: LinkTarget): QualifiedName | undefined {
  return to.kind === 'resource' ? undefined : to.name;
}
