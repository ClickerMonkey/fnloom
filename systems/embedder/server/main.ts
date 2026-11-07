/** The embedder system's process: the HTTP client over the EmbeddingGemma service, served to the hub. */
import { setTimeout as wait } from 'node:timers/promises';
import type { Json } from '@harness/core';
import type { Log } from '@harness/sdk';
import { serve } from '@harness/sdk/server';
import { embedderSystem } from '../shared/index.ts';
import { embedderEnv } from './env.ts';
import { HttpGemmaClient } from './http.ts';
import { createEmbedderImpl } from './impl.ts';

const settings = embedderEnv.parse();

/** The process log: structured console lines, which the runtime's log interception picks up. */
const log: Log = {
  debug: (key, fields?: Record<string, Json>) => { console.debug(key, fields ?? {}); },
  info: (key, fields?: Record<string, Json>) => { console.info(key, fields ?? {}); },
  warn: (key, fields?: Record<string, Json>) => { console.warn(key, fields ?? {}); },
  error: (key, fields?: Record<string, Json>, error?: unknown) => { console.error(key, fields ?? {}, error); },
};

// the client reads the URL the implementation follows from config; set just below
const server = createEmbedderImpl({
  client: new HttpGemmaClient({
    url: () => server.url(),
    fetch: (input, init) => fetch(input, init),
    sleep: async (ms, signal) => { await wait(ms, undefined, signal === undefined ? {} : { signal }); },
    limits: { batch: settings.EMBEDDER_BATCH, retries: settings.EMBEDDER_RETRIES, retryDelay: settings.EMBEDDER_RETRY_DELAY, retryMax: settings.EMBEDDER_RETRY_MAX, timeout: settings.EMBEDDER_TIMEOUT },
    log,
  }),
  defaultUrl: settings.HARNESS_EMBEDDER_URL,
  queryCache: settings.EMBEDDER_QUERY_CACHE,
});

log.info('embedder.serving', { hub: settings.HARNESS_HUB, url: settings.HARNESS_EMBEDDER_URL });
const running = await serve(embedderSystem, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
});
running.onStatus((status) => { log.info('embedder.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
