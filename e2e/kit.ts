/**
 * What the e2e tests drive the hub with: a signed-in admin client for the hub under test, and the session helpers
 * the UI test fixtures share (`scripts/session.ts`).
 */
import { inject } from 'vitest';
import { signIn, type SignedIn } from '../scripts/hub-client.ts';
import { e2eEnv } from './env.ts';

export { Approver, ask, clientInfo, finished, SessionWatch, statusOf, textOf } from '../scripts/session.ts';

/** The e2e settings, parsed once. */
export const settings = e2eEnv.parse();

/** Sign in to the hub under test as its admin. */
export function admin(): Promise<SignedIn> {
  const hub = inject('e2eHub');
  return signIn(hub.url, { email: hub.email, password: hub.password });
}

export { settle } from '../scripts/hub-client.ts';
