/** Callers for https on the hub's port: everyone signed in reads it, admins switch it. */
import type { Hub } from './client.ts';

/** Make the https callers. */
export function httpsApi(hub: Hub) {
  return {
    https: hub.caller('https', { dedupe: true }),
    setHttps: hub.caller('setHttps'),
  };
}

/** The https callers. */
export type HttpsApi = ReturnType<typeof httpsApi>;
