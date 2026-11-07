/** Callers for signing in and out. State that follows from them lives in `state/session.ts`. */
import { hub } from './client.ts';

export const setupCaller = hub.caller('setup', { cache: { ttl: 5_000 } });
export const createAdminCaller = hub.caller('createAdmin');
export const signInCaller = hub.caller('signIn');
export const refreshCaller = hub.caller('refresh');
export const signOutCaller = hub.caller('signOut');
