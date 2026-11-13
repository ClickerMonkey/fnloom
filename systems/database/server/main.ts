/**
 * The database system's process, one per database instance: the enricher over the hub's models (its enrichments are
 * kept with the table types in the hub), served to the hub. Once serving, the lifecycle opens and scans the configured
 * database. Its rows are drawn by the app's own result view, so it has no client bundle. Saved queries are the hub's fns;
 * nothing is restored here.
 */
import { loggedHost, placeFolders, serve, type RunningSystem } from '@harness/sdk/server';
import { database } from '../shared/index.ts';
import { LlmEnricher } from './author.ts';
import { databaseEnv } from './env.ts';
import { HUB_FLEET, createDatabaseImpl, type HubLink } from './impl.ts';
const settings = databaseEnv.parse();
const { dataDir } = placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const instance = settings.HARNESS_INSTANCE;
const { host, log } = loggedHost(database.name);

// the running system, once `serve()` returns: table types wait for it, so nothing here depends on
// the lifecycle starting only after the hub's welcome
let resolveRunning: (system: RunningSystem<typeof database.name>) => void = () => undefined;
const serving = new Promise<RunningSystem<typeof database.name>>((resolve) => { resolveRunning = resolve; });
const hub: HubLink = {
  types: async (upsert, remove) => { await (await serving).types(upsert, remove); },
  searchFns: async (query) => (await serving).searchFns(query),
};
const server = createDatabaseImpl({
  settings, instance, dataDir,
  enricher: new LlmEnricher(),
  fleet: HUB_FLEET,
  hub: () => hub,
  now: () => Date.now(),
});

log.info('database.serving', { hub: settings.HARNESS_HUB, instance });
const running = await serve(database, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
resolveRunning(running);
running.onStatus((status) => { log.info('database.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().then(() => server.close()).finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
