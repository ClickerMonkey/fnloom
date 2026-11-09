/** The Google Calendar system's process: Google over the real `fetch`, served to the hub. */
import { loggedHost, serve } from '@harness/sdk/server';
import { googleCalendar } from '../shared/index.ts';
import { calendarEnv } from './env.ts';
import { FetchGoogleApi } from './google.ts';
import { createCalendarImpl } from './impl.ts';

const settings = calendarEnv.parse();
const { host, log } = loggedHost(googleCalendar.name);

const impl = createCalendarImpl({
  settings,
  api: new FetchGoogleApi({ fetch: (input, init) => fetch(input, init), timeout: settings.CALENDAR_TIMEOUT }),
  now: () => Date.now(),
});

log.info('calendar.serving', { hub: settings.HARNESS_HUB });
const running = await serve(googleCalendar, impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('calendar.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
