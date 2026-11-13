/**
 * Scores for the graph contextor. A candidate's base score is its weight times a weighted mean of radial basis
 * functions of its signals, `w(c) · Σ W_m · rbf(f_m(c), t_m, k_m) / Σ W_m` with `rbf(x, t, k) = e^(−k(x−t)²)`, over
 * only the metrics it has a signal for (an item is never punished for a signal it can't have), so the score stays in
 * `[0, w(c)]`. Activation then spreads over links like a personalised PageRank with a fixed number of steps: each
 * hop adds `λ` of what flows in along an edge and `λ/2` of what flows back against it, with every item's out-weights
 * normalised so an item with many links passes on no more than one with a few.
 */
import { GRAPH_METRICS, type GraphMetric, type MetricWeight } from '@harness/core';
import type { MetricSetting } from './env.ts';

export type { MetricSetting } from './env.ts';

/** One candidate's signals; a metric left out (or undefined) has no signal for it. */
export type Signals = Partial<Record<GraphMetric, number | undefined>>;

/** `e^(−k(x−t)²)`: 1 at the target, falling away on both sides. */
export function rbf(x: number, target: number, k: number): number {
  return Math.exp(-k * (x - target) ** 2);
}

/** The defaults (`metricDefaults`, from the settings) with a session's overrides on top. */
export function metricSettings(defaults: Readonly<Record<GraphMetric, MetricSetting>>, overrides: Partial<Record<GraphMetric, MetricWeight>>): Record<GraphMetric, MetricSetting> {
  const settings = { ...defaults };
  for (const metric of GRAPH_METRICS) {
    const override = overrides[metric];
    if (override !== undefined) settings[metric] = { weight: override.weight, target: override.target ?? defaults[metric].target, k: override.k ?? defaults[metric].k };
  }
  return settings;
}

/** A candidate's base score: its weight times the weighted mean of its signals' rbfs (0 without any signal). */
export function baseScore(signals: Signals, weight: number, settings: Readonly<Record<GraphMetric, MetricSetting>>): number {
  if (weight <= 0) return 0;
  let sum = 0;
  let weights = 0;
  for (const metric of GRAPH_METRICS) {
    const value = signals[metric];
    const setting = settings[metric];
    if (value === undefined || !Number.isFinite(value) || setting.weight <= 0) continue;
    sum += setting.weight * rbf(value, setting.target, setting.k);
    weights += setting.weight;
  }
  return weights === 0 ? 0 : (weight * sum) / weights;
}

/** A directed, weighted edge between two candidates, by key. */
export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
}

/**
 * Spread base scores over edges: `aʰ⁺¹(c) = s₀(c) + λ Σ_{u→c} ŵ(u,c) aʰ(u) + λ/2 Σ_{c→u} ŵ(c,u) aʰ(u)`, `hops` times,
 * where `ŵ(u,·) = weight / max(1, Σ out-weights of u)`. Items reached only by edges start at 0.
 */
export function spread(base: ReadonlyMap<string, number>, edges: readonly Edge[], damping: number, hops: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const edge of edges) out.set(edge.from, (out.get(edge.from) ?? 0) + Math.max(0, edge.weight));
  const normalised = edges.map((edge) => ({ ...edge, weight: Math.max(0, edge.weight) / Math.max(1, out.get(edge.from) ?? 0) }));
  const keys = new Set<string>([...base.keys(), ...edges.flatMap((e) => [e.from, e.to])]);
  let current = new Map<string, number>([...keys].map((key) => [key, base.get(key) ?? 0]));
  for (let hop = 0; hop < hops; hop++) {
    const next = new Map<string, number>([...keys].map((key) => [key, base.get(key) ?? 0]));
    for (const edge of normalised) {
      next.set(edge.to, (next.get(edge.to) ?? 0) + damping * edge.weight * (current.get(edge.from) ?? 0));
      next.set(edge.from, (next.get(edge.from) ?? 0) + (damping / 2) * edge.weight * (current.get(edge.to) ?? 0));
    }
    current = next;
  }
  return current;
}

/** Words of three letters or more, lowercased, without the commonest English words. */
export function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word)));
}

/** The share of the query's words a text has (absent when the query has none). */
export function wordShare(query: ReadonlySet<string>, text: string): number | undefined {
  if (query.size === 0) return undefined;
  const have = words(text);
  let shared = 0;
  for (const word of query) if (have.has(word)) shared += 1;
  return shared / query.size;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'his', 'how', 'its',
  'may', 'new', 'now', 'see', 'who', 'did', 'get', 'let', 'say', 'she', 'too', 'use', 'that', 'this', 'with', 'what', 'when', 'from', 'they', 'will',
  'would', 'there', 'their', 'which', 'about', 'into', 'than', 'then', 'them', 'these', 'some', 'could', 'other', 'your', 'does', 'just', 'also',
]);
