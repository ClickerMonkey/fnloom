/**
 * The one ayepi client for the hub's web API, over the browser's WebSocket (HTTP for what must be HTTP). Components
 * never import this: callers live in `api/*.ts` and reactive state in `state/*.ts`.
 */
import { client, wsTransport, type ApiClient } from '@ayepi/core/client';
import type { HubWebSpec } from '@harness/core';
import { accessToken } from '../state/session.ts';
import { manifest } from './manifest.gen.ts';

/** The hub's origin; in dev, Vite proxies it. */
const origin = window.location.origin;

/** The browser's socket to the hub. It reconnects with backoff and re-subscribes live channels. */
export const socket = wsTransport(
  () => `${origin.replace(/^http/, 'ws')}/ws${accessToken.value === '' ? '' : `?access_token=${encodeURIComponent(accessToken.value)}`}`,
  { whileDisconnected: 'queue', heartbeat: { interval: 30_000, timeout: 10_000 }, backoff: { initial: 500, max: 15_000 } },
);

/** The typed web API client. */
export const hub: ApiClient<HubWebSpec> = client<HubWebSpec>({
  baseUrl: `${origin}/api`,
  manifest,
  headers: () => (accessToken.value === '' ? {} : { authorization: `Bearer ${accessToken.value}` }),
  ws: socket,
  prefer: 'ws',
});
