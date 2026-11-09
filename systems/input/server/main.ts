/**
 * The input system's process: saved forms in its data folder, the form agent over the hub's models, the renderers
 * built into its state folder, served to the hub; once serving, the saved forms are added as fns again.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyFnRef } from '@harness/sdk';
import { buildClient } from '@harness/sdk/build';
import { loggedHost, placeFolders, serve } from '@harness/sdk/server';
import { input } from '../shared/index.ts';
import { LlmFormAuthor } from './author.ts';
import { inputEnv } from './env.ts';
import { createInputImpl, type RuntimeFns } from './impl.ts';
import { FileForms } from './store.ts';

const settings = inputEnv.parse();
const { dataDir } = placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(input.name);

// saved forms are added once the system is serving
const runtime: { current: RuntimeFns | undefined } = { current: undefined };
const server = createInputImpl({
  settings,
  store: new FileForms(dataDir),
  author: new LlmFormAuthor({ retries: settings.INPUT_AUTHOR_RETRIES, maxFields: settings.INPUT_MAX_FIELDS }),
  runtime: () => runtime.current,
  now: () => Date.now(),
});

const clientFolder = join(settings.HARNESS_SYSTEM_STATE, 'client');
await buildClient({ entry: fileURLToPath(new URL('../client/index.ts', import.meta.url)), outDir: clientFolder });

log.info('input.serving', { hub: settings.HARNESS_HUB });
const running = await serve(input, server.impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('input.status', { status }); });
const added = new Map<string, AnyFnRef>();
runtime.current = {
  add: async (name, def) => { added.set(name, await running.add(name, def)); },
  remove: async (name) => {
    const ref = added.get(name);
    if (ref !== undefined) { await running.remove(ref); added.delete(name); }
  },
};
await running.ready();
log.info('input.restored', { forms: await server.restore() });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
