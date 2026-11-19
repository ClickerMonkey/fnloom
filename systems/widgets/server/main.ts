/**
 * The widgets system's process: its renderers (a proposal's card, a saved widget's result, the saved widgets' page)
 * built into its state folder and served to the hub with its contract. Saved widgets live in the hub, so nothing is
 * restored here.
 */
import { join } from 'node:path';
import { loggedHost, placeFolders, rendererFolder, serve } from '@harness/sdk/server';
import { widgets } from '../shared/index.ts';
import { widgetsEnv } from './env.ts';
import { createWidgetsImpl } from './impl.ts';

const settings = widgetsEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(widgets.name);

const clientFolder = await rendererFolder({ main: import.meta.url, outDir: join(settings.HARNESS_SYSTEM_STATE, 'client') });

log.info('widgets.serving', { hub: settings.HARNESS_HUB });
const running = await serve(widgets, createWidgetsImpl({ settings }), {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('widgets.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
