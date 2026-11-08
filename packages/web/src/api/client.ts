/**
 * The one ayepi client for the hub's web API: over the browser's WebSocket for calls and live events, and HTTP for the
 * sign-in calls made before there is a token. Components never import this; callers live in `api/*.ts` and reactive
 * state in `state/*.ts`, which receive the callers they use, so tests hand them fakes.
 */
import { client, wsTransport, type ApiClient, type ClientWs, type WsTransport } from '@ayepi/core/client';
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
  /**
   * The hub refused a call made with the access token (401): the sign-in ended there (its tokens expired, or the hub
   * forgot them). Calls made before sign-in (no token) don't count. Resolves whether the tab is signed in again (it
   * refreshed); if so, a call the socket carried is sent once more, so the page never sees that refusal.
   */
  readonly unauthorized?: () => Promise<boolean>;
}

/** The keys of a ws frame this file reads (see the ayepi ws wire protocol). */
interface WireFrame {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly abort?: unknown;
  readonly end?: unknown;
  readonly $status?: unknown;
}

/** A ws frame as an object, or undefined when it isn't one. */
function frameOf(raw: string): WireFrame | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a ws frame is a call the hub refused for its token: `$status` 401 (see the ayepi ws wire protocol). */
export function isRefusedFrame(frame: string): boolean {
  return frame.includes('"$status":401') && frameOf(frame)?.$status === 401;
}

/**
 * The socket as the client sees it. A call the hub refuses for its token is held back: the tab refreshes its tokens
 * (the hub closes a socket whose token has expired, so it reconnects with the new one) and the call is sent once
 * more. Only when that fails, or the call streamed items up (which can't be sent again), does the refusal reach the
 * caller.
 */
export function watchRefusals(socket: WsTransport, recover: () => Promise<boolean>): ClientWs {
  /** Calls waiting for their answer, by id: the frame to send again, or undefined once it can't be. */
  const open = new Map<string, string | undefined>();
  return {
    send: (raw) => {
      const frame = frameOf(raw);
      const id = frame?.id;
      if (typeof id === 'string') {
        if (typeof frame?.type === 'string') { open.set(id, raw); }
        else if (frame?.abort === true) { open.delete(id); }
        else if (open.has(id)) { open.set(id, undefined); }
      }
      socket.send(raw);
    },
    onMessage: (cb) => {
      socket.onMessage((raw) => {
        const frame = frameOf(raw);
        const id = frame?.id;
        if (frame === undefined || typeof id !== 'string' || !('$status' in frame || frame.end === true)) { cb(raw); return; }
        const again = open.get(id);
        open.delete(id);
        if (frame.$status !== 401) { cb(raw); return; }
        void recover().then((signedIn) => {
          if (signedIn && again !== undefined) { socket.send(again); } else { cb(raw); }
        });
      });
    },
    onState: (cb) => socket.onState(cb),
  };
}

/** `fetch`, reporting each call made with a token that the hub refused. */
function watchedFetch(refused: () => unknown): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await fetch(request);
    if (response.status === 401 && request.headers.has('authorization')) { void refused(); }
    return response;
  };
}

/** Socket settings: queue calls while reconnecting, check the line every 30s, back off up to 15s between tries. */
const SOCKET = { whileDisconnected: 'queue', heartbeat: { interval: 30_000, timeout: 10_000 }, backoff: { initial: 500, max: 15_000 } } as const;


/** Make the client and its socket. The socket connects on the first call or subscription that needs it. */
export function createHub(options: HubOptions): { hub: Hub; socket: WsTransport } {
  const socket = wsTransport(() => {
    const token = options.token();
    return `${options.origin.replace(/^http/, 'ws')}/ws${token === '' ? '' : `?access_token=${encodeURIComponent(token)}`}`;
  }, SOCKET);
  const refused = options.unauthorized;
  const hub = client<HubWebSpec>({
    baseUrl: `${options.origin}/api`,
    manifest,
    headers: () => {
      const token = options.token();
      return token === '' ? {} : { authorization: `Bearer ${token}` };
    },
    ws: refused === undefined ? socket : watchRefusals(socket, refused),
    ...(refused === undefined ? {} : { fetchImpl: watchedFetch(refused) }),
    prefer: 'ws',
  });
  return { hub, socket };
}
