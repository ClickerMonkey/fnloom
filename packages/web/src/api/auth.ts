/**
 * Callers for signing in and out. The calls made before there is a token go over HTTP, because the socket keeps the
 * token it connected with; the socket then connects, signed in, on the first call that needs it.
 */
import type { Hub } from './client.ts';

/** Make the sign-in callers. */
export function authApi(hub: Hub) {
  return {
    setup: hub.caller('setup', { cache: { ttl: 5_000 }, dedupe: true }),
    createAdmin: hub.caller('createAdmin'),
    signIn: hub.caller('signIn'),
    refresh: hub.caller('refresh'),
    signOut: hub.caller('signOut'),
    me: hub.caller('me', { dedupe: true }),
  };
}

/** The sign-in callers. */
export type AuthApi = ReturnType<typeof authApi>;

/** Calls made before sign-in travel over HTTP. */
export const BEFORE_SIGN_IN = { transport: 'http' } as const;
