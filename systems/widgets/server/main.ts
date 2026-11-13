/**
 * The widgets system's process: its contract served to the hub. Saved widgets live in the hub, so nothing is restored
 * here, and it has no client bundle: the web app draws every widget.
 */
import { loggedHost, placeFolders, serve } from '@harness/sdk/server';
import { widgets } from '../shared/index.ts';
import { widgetsEnv } from './env.ts';
import { createWidgetsImpl } from './impl.ts';

const settings = widgetsEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(widgets.name);

log.info('widgets.serving', { hub: settings.HARNESS_HUB });
const running = await serve(widgets, createWidgetsImpl({ settings }), {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('widgets.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
