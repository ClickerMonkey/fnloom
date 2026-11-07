/**
 * The one ayepi client for the hub's web API: over the browser's WebSocket for calls and live events, and HTTP for the
 * sign-in calls made before there is a token. Components never import this; callers live in `api/*.ts` and reactive
 * state in `state/*.ts`, which receive the callers they use, so tests hand them fakes.
 */
import { client, wsTransport, type ApiClient, type WsTransport } from '@ayepi/core/client';
import type { CallArgs, CallReturn, Caller } from '@ayepi/core';
import type { HubWebSpec } from '@harness/core';
import { manifest } from './manifest.gen.ts';

/** The typed web API client: the hub's web API (`hubWebSpec`). */
export type Hub = ApiClient<HubWebSpec>;
/** The name of a web API endpoint. */
export type Endpoint = keyof HubWebSpec['endpoints'];
/** A caller of one endpoint: `call` typed from the spec, plus `cancel`, `invalidate` and `pending`. */
export type CallerOf<K extends Endpoint> = Caller<HubWebSpec['endpoints'][K]>;
/** What endpoint `K` answers, from its schema in `hubWebSpec`: a state shape never restates it by hand. */
export type ResponseOf<K extends Endpoint> = Awaited<CallReturn<HubWebSpec['endpoints'][K]>>;
/** What endpoint `K` takes, from its schema in `hubWebSpec`. */
export type BodyOf<K extends Endpoint> = NonNullable<CallArgs<HubWebSpec['endpoints'][K]>[0]>;
/** The client's live online/offline state. */
export type Connection = Hub['connection'];

/** Where the hub is, and how to find the current access token. */
export interface HubOptions {
  /** The page's origin; the API is at `/api` and the socket at `/ws` (Vite proxies both in dev). */
  readonly origin: string;
  /** The access token, or '' when signed out. Read again for every HTTP call and every socket connect. */
  readonly token: () => string;
}

/** Socket settings: queue calls while reconnecting, check the line every 30s, back off up to 15s between tries. */
const SOCKET = { whileDisconnected: 'queue', heartbeat: { interval: 30_000, timeout: 10_000 }, backoff: { initial: 500, max: 15_000 } } as const;


/** Make the client and its socket. The socket connects on the first call or subscription that needs it. */
export function createHub(options: HubOptions): { hub: Hub; socket: WsTransport } {
  const socket = wsTransport(() => {
    const token = options.token();
    return `${options.origin.replace(/^http/, 'ws')}/ws${token === '' ? '' : `?access_token=${encodeURIComponent(token)}`}`;
  }, SOCKET);
  const hub = client<HubWebSpec>({
    baseUrl: `${options.origin}/api`,
    manifest,
    headers: () => {
      const token = options.token();
      return token === '' ? {} : { authorization: `Bearer ${token}` };
    },
    ws: socket,
    prefer: 'ws',
  });
  return { hub, socket };
}
