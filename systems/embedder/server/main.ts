/** The embedder system's process: the HTTP client over the EmbeddingGemma service, served to the hub. */
import { loggedHost, serve } from '@harness/sdk/server';
import { embedderSystem } from '../shared/index.ts';
import { embedderEnv } from './env.ts';
import { HttpGemmaClient, limitsFrom, timerSleep } from './http.ts';
import { createEmbedderImpl } from './impl.ts';

const settings = embedderEnv.parse();

const { host, log } = loggedHost(embedderSystem.name);

// the client reads the URL the implementation follows from config; set just below
const server = createEmbedderImpl({
  client: new HttpGemmaClient({
    url: () => server.url(),
    fetch: (input, init) => fetch(input, init),
    sleep: timerSleep,
    limits: limitsFrom(settings),
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
}, host);
running.onStatus((status) => { log.info('embedder.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
