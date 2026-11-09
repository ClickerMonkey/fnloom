/**
 * The Google Calendar system's process: Google over the real `fetch`, served to the hub.
 *
 * The SDK does not serve the connect link endpoints yet (`connectStart`, `connectFinish`, `disconnect`, and a run's
 * `connection` with `connectionUpdate`): until it does, the contract declares no `connect`, runs find no connection
 * (`readConnection` reads the run request's field the day the SDK passes it on), and refreshed tokens are logged, not
 * sent. `server.connect` is the flow the SDK will serve.
 */
import { RunConnection } from '@harness/core';
import { loggedHost, serve } from '@harness/sdk/server';
import { googleCalendar } from '../shared/index.ts';
import { calendarEnv } from './env.ts';
import { FetchGoogleApi } from './google.ts';
import { createCalendarImpl } from './impl.ts';

const settings = calendarEnv.parse();
const { host, log } = loggedHost(googleCalendar.name);

/** The run's connection, when the SDK puts the run request's `connection` on the ctx. */
function readConnection(ctx: object): RunConnection | undefined {
  const parsed = RunConnection.safeParse(Reflect.get(ctx, 'connection'));
  return parsed.success ? parsed.data : undefined;
}

const server = createCalendarImpl({
  settings,
  api: new FetchGoogleApi({ fetch: (input, init) => fetch(input, init), timeout: settings.CALENDAR_TIMEOUT }),
  connections: {
    of: readConnection,
    update: (update) => {
      log.warn('calendar.update.unsent', { connection: update.connection, expired: 'expired' in update.update });
      return Promise.resolve();
    },
  },
  now: () => Date.now(),
});

log.info('calendar.serving', { hub: settings.HARNESS_HUB });
const running = await serve(googleCalendar, server.impl, {
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
