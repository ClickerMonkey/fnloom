/**
 * The score thresholds read one scale, a hit's similarity of meaning (`SearchHit.similarity`), never its fused rank:
 * these keep the graph contextor (its threshold, through the embedding metric's steepness) and the decision model's
 * floor in step with the hub's suggestion threshold, so a change to one shows in the others (regression: both were
 * set when every hit scored near 1).
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

describe('score thresholds', () => {
  it('lets an item known by meaning alone into the graph from about the suggestion threshold', () => {
    expect(byMeaning(suggestAt)).toBeGreaterThanOrEqual(threshold);
    expect(byMeaning(suggestAt - 0.05)).toBeLessThan(threshold);
  });

  it('keeps unrelated text (0.2 to 0.4 with EmbeddingGemma) out of the graph, and a close fit well in', () => {
    for (const unrelated of [0.2, 0.3, 0.4]) expect(byMeaning(unrelated)).toBeLessThan(threshold);
    expect(byMeaning(0.7)).toBeGreaterThan(2 * threshold);
  });

  it('gives the decision model near misses under the suggestion threshold, but not the bottom of unrelated text', () => {
    const { floor } = SuggestPicking.parse({});
    expect(floor).toBeLessThan(suggestAt);
    expect(floor).toBeGreaterThan(0.2);
  });
});
