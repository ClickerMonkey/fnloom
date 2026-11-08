/**
 * A typed client of a running hub's web API, for scripts (`npm run dev`, the e2e tests): HTTP for calls, and the hub's
 * socket (`/ws`) for live events once signed in. It signs in as the single admin account from the environment.
 */
import { client, wsTransport, type ApiClient, type WsTransport } from '@ayepi/core/client';
import { hubWebSpec, type HubWebSpec, type Tokens } from '@harness/core';

/** The web API, typed from the spec. */
export type HubClient = ApiClient<HubWebSpec>;

/** A signed-in client, its current tokens, and its socket. `close` closes the socket and stops renewing the tokens. */
export interface SignedIn {
  readonly hub: HubClient;
  readonly tokens: Tokens;
  readonly socket: WsTransport;
  close(): void;
}

/** How long before the access token expires it is renewed, in ms. */
const RENEW_BEFORE = 60_000;
/** How long to wait before trying again when a renewal fails, in ms. */
const RENEW_RETRY = 5_000;

/** The admin account's sign-in. */
export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/** A client that isn't signed in (`setup`, `signIn`). */
export function anonymous(origin: string): HubClient {
  return client<HubWebSpec>({ baseUrl: `${origin}/api`, manifest: hubWebSpec });
}

/**
 * Sign in and return a client whose calls and socket carry the access token. The tokens are renewed shortly before
 * the access token expires, so a long script (a full `npm run ui-tests`) stays signed in; the socket reconnects with
 * the current token when the hub closes it for an expiring one.
 */
export async function signIn(origin: string, credentials: Credentials): Promise<SignedIn> {
  const anon = anonymous(origin);
  let tokens = await anon.call('signIn', credentials, { transport: 'http' });
  const socket = wsTransport(() => `${origin.replace(/^http/, 'ws')}/ws?access_token=${encodeURIComponent(tokens.access)}`, { whileDisconnected: 'queue' });
  const hub = client<HubWebSpec>({
    baseUrl: `${origin}/api`, manifest: hubWebSpec, headers: () => ({ authorization: `Bearer ${tokens.access}` }), ws: socket,
  });
  let timer: NodeJS.Timeout | undefined;
  const renewIn = (delay: number): void => {
    timer = setTimeout(() => {
      anon.call('refresh', { refresh: tokens.refresh }, { transport: 'http' }).then(
        (next) => { tokens = next; renewIn(Math.max(next.expiresIn - RENEW_BEFORE, RENEW_RETRY)); },
        (error: unknown) => { console.warn('hub-client.renew.failed', { error: error instanceof Error ? error.message : String(error) }); renewIn(RENEW_RETRY); },
      );
    }, delay);
    timer.unref();
  };
  renewIn(Math.max(tokens.expiresIn - RENEW_BEFORE, RENEW_RETRY));
  return {
    hub, socket,
    get tokens() { return tokens; },
    close: () => { clearTimeout(timer); socket.close(); },
  };
}

/** Poll `check` every `every` ms until it returns a value, or fail after `timeout` ms with `what` in the message. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, options: { timeout: number; every?: number }): Promise<T> {
  const deadline = Date.now() + options.timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) { return value; }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.every ?? 250));
  }
  throw new Error(`timed out after ${options.timeout}ms waiting for ${what}${last === undefined ? '' : `: ${last instanceof Error ? last.message : JSON.stringify(last)}`}`);
}

/** Wait until the socket is up: a read over it succeeds, so subscriptions sent before it are live. */
export function settle(client: SignedIn): Promise<true> {
  return waitFor('the socket', async () => { await client.hub.call('me', { transport: 'ws' }); return true as const; }, { timeout: 10_000 });
}
