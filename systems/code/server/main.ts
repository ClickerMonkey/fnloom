/**
 * The code system's process: its contract served to the hub. Code fns live in the hub, so nothing is restored here,
 * and it has no client bundle.
 */
import { loggedHost, placeFolders, serve } from '@harness/sdk/server';
import { code } from '../shared/index.ts';
import { codeEnv } from './env.ts';
import { createCodeImpl } from './impl.ts';

const settings = codeEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(code.name);

log.info('code.serving', { hub: settings.HARNESS_HUB });
const running = await serve(code, createCodeImpl({ settings }), {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('code.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
