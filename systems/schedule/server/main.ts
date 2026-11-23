/**
 * The schedule system's process: its contract served to the hub. Schedules live in the hub as fns of its kind; the
 * timer that will start their firings (slice 6) keeps its queue in this system's data folder. No client bundle yet:
 * the pages come with slice 8.
 */
import { loggedHost, placeFolders, serve } from '@harness/sdk/server';
import { schedule } from '../shared/index.ts';
import { scheduleEnv } from './env.ts';
import { createScheduleImpl } from './impl.ts';

const settings = scheduleEnv.parse();
placeFolders(settings.HARNESS_SYSTEM_STATE, settings);
const { host, log } = loggedHost(schedule.name);

log.info('schedule.serving', { hub: settings.HARNESS_HUB });
const running = await serve(schedule, createScheduleImpl({ settings }), {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('schedule.status', { status }); });
await running.ready();

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
