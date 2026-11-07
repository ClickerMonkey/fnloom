/**
 * The embedder system end to end over the SDK's real link runtime: `serve` connects to an in-memory hub (`FakeHub`),
 * sends the manifest with both embedders, and the hub's `embed` calls cross the link. The service is a fake client.
 */
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub } from '@harness/sdk/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { GEMMA_DIMENSIONS, embedderSystem, type GemmaTask } from '../shared/index.ts';
import { createEmbedderImpl } from './impl.ts';
import type { GemmaClient } from './index.ts';

/** A service that answers each text with a vector whose first number is its task's index and second its length. */
class FakeClient implements GemmaClient {
  readonly asked: Array<[readonly string[], GemmaTask]> = [];
  embed(texts: readonly string[], task: GemmaTask): Promise<number[][]> {
    this.asked.push([texts, task]);
    return Promise.resolve(texts.map((text) => Array.from({ length: GEMMA_DIMENSIONS }, (_, i) => (i === 0 ? Number(task === 'query') : i === 1 ? text.length : 0))));
  }

  health() {
    return Promise.resolve({ status: 'ok' as const, model: 'fake', dim: GEMMA_DIMENSIONS });
  }
}

describe('embedder over the link', () => {
  let running: RunningSystem<'embedder'> | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('declares both embedders at 768 dimensions and embeds each with its task', async () => {
    const client = new FakeClient();
    const hub = new FakeHub({ config: {} });
    running = await serve(embedderSystem, createEmbedderImpl({ client, defaultUrl: 'http://gemma', queryCache: 10 }).impl, { hub: 'ws://hub.test/link', state: 'unused', version: '0.0.0' }, hub.host());
    await running.ready();

    const manifest = JSON.stringify(hub.manifests[0]);
    expect(manifest).toContain('"document"');
    expect(manifest).toContain('"query"');
    expect(manifest).toContain(String(GEMMA_DIMENSIONS));

    const peer = hub.peer();
    const documents = await peer.call('embed', { embedder: 'document', texts: ['ab', 'abc'] });
    expect(documents.vectors.map((v) => [v.length, v[0], v[1]])).toEqual([[GEMMA_DIMENSIONS, 0, 2], [GEMMA_DIMENSIONS, 0, 3]]);
    await peer.call('embed', { embedder: 'query', texts: ['q'] });
    await peer.call('embed', { embedder: 'query', texts: ['q'] });
    expect(client.asked).toEqual([[['ab', 'abc'], 'document'], [['q'], 'query']]);
  });
});
