/** Callers for the hub's display name: anyone reads it (the sign-in page shows it), admins set it. */
import type { Hub } from './client.ts';

/** Make the hub-name callers. */
export function identityApi(hub: Hub) {
  return {
    identity: hub.caller('identity', { dedupe: true }),
    setHubName: hub.caller('setHubName'),
  };
}

/** The hub-name callers. */
export type IdentityApi = ReturnType<typeof identityApi>;
