/**
 * The score thresholds read one scale, a hit's similarity of meaning (`SearchHit.similarity`), never its fused rank:
 * these keep the graph contextor (its threshold, through the embedding metric's steepness), the hub's suggestion
 * threshold and the decision model's floor in their places on it, so a change to one shows here (regression: they
 * were set when every hit scored near 1).
 *
 * Measured on 2026-11-22 with EmbeddingGemma over a scenario hub's 262 fns and context items and 42 ordinary
 * requests: a close fit scores 0.35 to 0.7, a relevant general fn 0.2 to 0.3, the median item 0.09 to 0.19 and the
 * 90th percentile at most 0.27. Suggestions with no model take what is over 0.3 (past nearly all noise); the decision
 * model sees what is over 0.2 (the near misses); the graph, which spreads weight from what it takes, takes an item by
 * its meaning alone only from a close fit, 0.45.
 */
import { ContextorConfig, SuggestPicking } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { chatEnv } from '../chat/env.ts';
import { contextorEnv, metricDefaults } from './env.ts';
import { baseScore } from './score.ts';

const suggestAt = chatEnv.parse().HARNESS_SUGGEST_THRESHOLD;
const metrics = metricDefaults(contextorEnv.parse());
const graph = ContextorConfig.parse({ type: 'graph' });
const threshold = graph.type === 'graph' ? graph.threshold : Number.NaN;
/** The activation of an item the graph knows by its meaning alone. */
const byMeaning = (similarity: number): number => baseScore({ embedding: similarity }, 1, metrics);
/** Where the graph takes an item by its meaning alone: a close fit. */
const GRAPH_ENTRY = 0.45;

describe('score thresholds', () => {
  it('lets an item known by meaning alone into the graph from a close fit', () => {
    expect(byMeaning(GRAPH_ENTRY)).toBeGreaterThanOrEqual(threshold);
    expect(byMeaning(GRAPH_ENTRY - 0.05)).toBeLessThan(threshold);
  });

  it('keeps unrelated text and loose fits (0.2 to 0.4) out of the graph, and a close fit well in', () => {
    for (const unrelated of [0.2, 0.3, 0.4]) expect(byMeaning(unrelated)).toBeLessThan(threshold);
    expect(byMeaning(0.7)).toBeGreaterThan(2 * threshold);
  });

  it('suggests with no model past nearly all noise (the 90th percentile item, 0.27), below the graph\'s close fit', () => {
    expect(suggestAt).toBeGreaterThan(0.27);
    expect(suggestAt).toBeLessThanOrEqual(GRAPH_ENTRY);
  });

  it('gives the decision model near misses under the suggestion threshold, but not the median item (0.09 to 0.19)', () => {
    const { floor } = SuggestPicking.parse({});
    expect(floor).toBeLessThan(suggestAt);
    expect(floor).toBeGreaterThanOrEqual(0.2);
  });
});
