// Live: the local EmbeddingGemma service (product/services/embedder) at HARNESS_EMBEDDER_URL. Skipped, with the
// reason, when it isn't running. Run with `npm run test:live`.
import { setTimeout as wait } from 'node:timers/promises';
import type { Log } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { GEMMA_DIMENSIONS } from '../shared/index.ts';
import { embedderEnv } from './env.ts';
import { HttpGemmaClient } from './http.ts';

const settings = embedderEnv.parse();
const quiet: Log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const client = new HttpGemmaClient({
  url: () => settings.HARNESS_EMBEDDER_URL,
  fetch: (input, init) => fetch(input, init),
  sleep: async (ms, signal) => { await wait(ms, undefined, signal === undefined ? {} : { signal }); },
  limits: { batch: settings.EMBEDDER_BATCH, retries: settings.EMBEDDER_RETRIES, retryDelay: settings.EMBEDDER_RETRY_DELAY, retryMax: settings.EMBEDDER_RETRY_MAX, timeout: settings.EMBEDDER_TIMEOUT },
  log: quiet,
});
const up = await client.health().then((h) => h.status === 'ok', () => false);

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe.skipIf(!up)(`the EmbeddingGemma service at ${settings.HARNESS_EMBEDDER_URL}`, () => {
  it('embeds documents and queries into one 768-dimension space where related text is closer', async () => {
    const [cats, invoices] = await client.embed(['Cats are small furry pets that purr.', 'Invoices are due within thirty days.'], 'document');
    const [query] = await client.embed(['which animal purrs?'], 'query');
    if (cats === undefined || invoices === undefined || query === undefined) { throw new Error('missing vectors'); }
    expect(cats).toHaveLength(GEMMA_DIMENSIONS);
    expect(dot(cats, cats)).toBeCloseTo(1, 3);
    expect(dot(query, cats)).toBeGreaterThan(dot(query, invoices));
  });
});
