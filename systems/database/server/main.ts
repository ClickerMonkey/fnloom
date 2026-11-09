/**
 * The database system's process, one per database instance: its saved queries and enrichments in its data folder,
 * the query agent and enricher over the hub's models, the visuals and result view built into its state folder, served
 * to the hub. Once serving, the lifecycle opens and scans the configured database and adds its saved queries as fns.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyFnRef } from '@harness/sdk';
import { buildClient } from '@harness/sdk/build';
import { loggedHost, placeFolders, serve } from '@harness/sdk/server';
import { database } from '../shared/index.ts';
import { LlmEnricher, LlmQueryAuthor } from './author.ts';
import { databaseEnv } from './env.ts';
import { SELF_FLEET, createDatabaseImpl } from './impl.ts';
import type { HubSide } from './instance.ts';
import type { RuntimeFns } from './queries.ts';
import { FileStore } from './store.ts';

const settings = databaseEnv.parse();
const { dataDir } = placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const instance = settings.HARNESS_INSTANCE;
const { host, log } = loggedHost(database.name);

// saved queries are added once the system is serving
const runtime: { current: RuntimeFns | undefined } = { current: undefined };
// the SDK has no runtime type patch yet: table types are logged, not sent (see the build 5 report)
const hub: HubSide = {
  types: (upsert, remove) => {
    log.warn('database.types-unsent', { upsert: upsert.map((decl) => decl.name), remove: [...remove] });
    return Promise.resolve();
  },
};
const server = createDatabaseImpl({
  settings, instance, dataDir,
  store: new FileStore(dataDir),
  author: new LlmQueryAuthor({ retries: settings.DATABASE_AUTHOR_RETRIES }),
  enricher: new LlmEnricher({ retries: settings.DATABASE_AUTHOR_RETRIES }),
  fleet: SELF_FLEET,
  hub: () => hub,
  runtime: () => runtime.current,
  now: () => Date.now(),
});

const clientFolder = join(settings.HARNESS_SYSTEM_STATE, 'client');
await buildClient({ entry: fileURLToPath(new URL('../client/index.ts', import.meta.url)), outDir: clientFolder });

log.info('database.serving', { hub: settings.HARNESS_HUB, instance });
const added = new Map<string, AnyFnRef>();
runtime.current = {
  add: async (name, def) => { added.set(name, await running.add(name, def)); },
  remove: async (name) => {
    const ref = added.get(name);
    if (ref !== undefined) { await running.remove(ref); added.delete(name); }
  },
};
const running = await serve(database, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('database.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().then(() => server.close()).finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
