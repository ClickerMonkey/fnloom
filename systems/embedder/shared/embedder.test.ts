import { Manifest } from '@harness/core';
import { manifestOf } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { GEMMA_DIMENSIONS, GemmaEmbedResponse, embedderSystem } from './index.ts';

describe('the embedder contract', () => {
  it('declares a document and a query embedder in one 768-dimension space', async () => {
    const manifest = await manifestOf(embedderSystem, { version: '0.0.0' });
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.embedders.map((e) => [e.name, e.dimensions])).toEqual([['document', GEMMA_DIMENSIONS], ['query', GEMMA_DIMENSIONS]]);
    expect(embedderSystem.embedders.query.name).toBe('embedder/query');
  });

  it('reads the service response, ignoring fields it does not use', () => {
    const body = { embeddings: [[0.1, 0.2]], dim: 2, model: 'embeddinggemma-300m', task: 'query', device: 'cpu', truncated_count: 0, trimmed: [] };
    expect(GemmaEmbedResponse.parse(body).embeddings).toEqual([[0.1, 0.2]]);
    expect(GemmaEmbedResponse.safeParse({ ...body, task: 'other' }).success).toBe(false);
  });
});
