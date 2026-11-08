/**
 * The template system's process: reads its settings, builds the implementation with the real dependencies, and serves
 * it to the hub, pairing the first time. `harness system build` bundles this file; the hub starts the bundle for an
 * installed system, and `npx tsx server/main.ts` starts it by hand.
 */
import { loggedHost, serve } from '@harness/sdk/server';
import { template } from '../shared/index.ts';
import { templateEnv } from './env.ts';
import { createImpl } from './impl.ts';

const settings = templateEnv.parse();
const { host, log } = loggedHost(template.name);

// TODO: build each outside dependency here and pass it to createImpl.
const impl = createImpl({ settings });

log.info('template.serving', { hub: settings.HARNESS_HUB });
const running = await serve(template, impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
  // client: the folder of the built renderers (`buildClient` from `@harness/sdk/build`), once `client/` has any.
}, host);
running.onStatus((status) => { log.info('template.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
