/**
 * The system's end of the link: one WebSocket to the hub carrying calls both ways. The system calls `hubLinkSpec`
 * through a typed ayepi client and serves `systemLinkSpec` back over the same socket (ayepi peers). The socket is a
 * `LinkSocket` from a `LinkTransport`, so tests run the whole link in memory.
 */
import { client, wsTransport, type ApiClient, type ClientWs, type Serves, type WsState } from '@ayepi/core';
import WebSocket from 'ws';
import { hubLinkSpec, type HubLinkSpec, type LinkLimits } from '@harness/core';

/** The typed hub, as a system calls it. */
export type HubLink = ApiClient<HubLinkSpec>;

/** How the runtime's parts reach the hub: they wait for a welcomed link, across reconnects. */
export interface HubAccess {
  /** The hub once the link is up and the hub has welcomed this system. Rejects when `signal` aborts or the system stops. */
  ready(signal?: AbortSignal): Promise<HubLink>;
  /** The hub right now, or `undefined` while there is no welcomed link. */
  now(): HubLink | undefined;
  /** The frame and chunk limits the hub set (defaults until the first welcome). */
  limits(): LinkLimits;
}

/** A reconnecting socket to the hub. */
export interface LinkSocket extends ClientWs {
  readonly state: WsState;
  /** Open now (it also opens on the first send). */
  connect(): void;
  /** Close for good; no more reconnects. */
  close(): void;
  onState(listener: (state: WsState) => void): () => void;
}

/** Opens link sockets. `WsLinkTransport` is the real one; tests use an in-memory one. */
export interface LinkTransport {
  open(url: string): LinkSocket;
}

/** Reconnect and heartbeat tuning for the WebSocket transport. Milliseconds. */
export interface WsLinkTuning {
  heartbeat: number;
  heartbeatTimeout: number;
  backoff: number;
  backoffMax: number;
}

/** A real WebSocket (the `ws` package's) with reconnect (exponential backoff with jitter) and a heartbeat. */
export class WsLinkTransport implements LinkTransport {
  readonly #tuning: WsLinkTuning;

  constructor(tuning: WsLinkTuning) {
    this.#tuning = tuning;
  }

  open(url: string): LinkSocket {
    return wsTransport(url, {
      WebSocket,
      whileDisconnected: 'fail',
      backoff: { initial: this.#tuning.backoff, max: this.#tuning.backoffMax, factor: 2, jitter: true },
      heartbeat: { interval: this.#tuning.heartbeat, timeout: this.#tuning.heartbeatTimeout },
    });
  }
}

/** The HTTP base of a link URL (`ws://hub:4300/link` → `http://hub:4300`), for the client's HTTP side. */
export function httpBase(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return parsed.origin;
}

/** The typed hub client over a socket, serving `serve` (the system's `systemLinkSpec` server) back on it. */
export function hubClient(url: string, socket: LinkSocket, serve: Serves): HubLink {
  return client<HubLinkSpec>({ baseUrl: httpBase(url), manifest: hubLinkSpec, ws: socket, serve, prefer: 'ws', validate: hubLinkSpec });
}
