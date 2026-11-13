/**
 * The api system's process (one per service): its contract served to the hub. Api fns live in the hub, so nothing is
 * restored here, and it has no client bundle.
 */
import { loggedHost, placeFolders, serve } from '@harness/sdk/server';
import { api } from '../shared/index.ts';
import { apiEnv } from './env.ts';
import { createApiImpl } from './impl.ts';

const settings = apiEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(api.name);

log.info('api.serving', { hub: settings.HARNESS_HUB });
const running = await serve(api, createApiImpl({ settings }), {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('api.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
