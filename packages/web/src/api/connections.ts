/**
 * The per-person systems' callers (a Google Calendar a person connects): every page with the asker's connections,
 * starting a connection, changing one, and disconnecting. They join the chat's callers (`chatApi`), as every page
 * reaches them through the chat store.
 */
import type { Hub } from './client.ts';

/** The cache tag of the connect pages, cleared by every change. */
export const CONNECTIONS_TAG = 'connections';

/** Make the connection callers. */
export function connectionsApi(hub: Hub) {
  return {
    connectPages: hub.caller('connectPages', { cache: { ttl: 30_000, tags: [CONNECTIONS_TAG] }, dedupe: true }),
    connect: hub.caller('connect', { invalidates: [CONNECTIONS_TAG] }),
    updateConnection: hub.caller('updateConnection', { invalidates: [CONNECTIONS_TAG] }),
    disconnect: hub.caller('disconnect', { invalidates: [CONNECTIONS_TAG] }),
  };
}

/** The connection callers. */
export type ConnectionsApi = ReturnType<typeof connectionsApi>;
