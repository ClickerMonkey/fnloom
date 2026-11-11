/**
 * The input system's process: its renderers built into its state folder, served to the hub. Saved forms live in the
 * hub, so nothing is restored here.
 */
import { join } from 'node:path';
import { loggedHost, placeFolders, rendererFolder, serve } from '@harness/sdk/server';
import { input } from '../shared/index.ts';
import { inputEnv } from './env.ts';
import { createInputImpl } from './impl.ts';

const settings = inputEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(input.name);

const clientFolder = await rendererFolder({ main: import.meta.url, outDir: join(settings.HARNESS_SYSTEM_STATE, 'client') });

log.info('input.serving', { hub: settings.HARNESS_HUB });
const running = await serve(input, createInputImpl({ settings }), {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('input.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
