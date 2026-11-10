/**
 * The random system's process: reads its settings, builds the implementation with the real dependencies, and serves
 * it to the hub, pairing the first time.
 */
import { loggedHost, serve } from '@harness/sdk/server';
import { random } from '../shared/index.ts';
import { randomEnv } from './env.ts';
import { createImpl } from './impl.ts';

const settings = randomEnv.parse();
const { host, log } = loggedHost(random.name);

const impl = createImpl({ settings });

log.info('random.serving', { hub: settings.HARNESS_HUB });
const running = await serve(random, impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('random.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
