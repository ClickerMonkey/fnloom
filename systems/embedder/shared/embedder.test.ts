import { Manifest } from '@harness/core';
import { manifestOf } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { GEMMA_DIMENSIONS, GemmaEmbedResponse, embedderSystem } from './index.ts';

describe('the embedder contract', () => {
  it('declares a provider with a document and a query embedding model in one 768-dimension space', async () => {
    const manifest = await manifestOf(embedderSystem, { version: '0.0.0' });
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect('embedders' in manifest).toBe(false);
    expect(manifest.providers?.map((p) => [p.name, p.models.map((m) => [m.id, m.capabilities, m.dimensions, m.pricing.input])])).toEqual([
      ['gemma', [['document', ['embedding'], GEMMA_DIMENSIONS, 0], ['query', ['embedding'], GEMMA_DIMENSIONS, 0]]],
    ]);
  });

  it('reads the service response, ignoring fields it does not use', () => {
    const body = { embeddings: [[0.1, 0.2]], dim: 2, model: 'embeddinggemma-300m', task: 'query', device: 'cpu', truncated_count: 0, trimmed: [] };
    expect(GemmaEmbedResponse.parse(body).embeddings).toEqual([[0.1, 0.2]]);
    expect(GemmaEmbedResponse.safeParse({ ...body, task: 'other' }).success).toBe(false);
  });
});
