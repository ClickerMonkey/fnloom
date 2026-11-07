/**
 * The hub's one port. HTTP: `/api/*` is the web API (its ayepi server, with the prefix taken off), `/_files` the
 * presigned files, `/docs/*` the API docs when on, `/healthz` and `/readyz` the health checks, `/clients/*` systems'
 * client builds, and everything else the built web app. WebSocket: `/ws` for browsers and `/link` for systems, each
 * on its own ayepi server.
 *
 * `@ayepi/node`'s `handleUpgrade` refuses sockets on other paths, so two of them can't share one `http.Server`
 * (library gap G3). Each is attached to its own unlistened `http.Server` instead, and this front hands every upgrade
 * to the one its path names. Browser sockets are closed shortly before their access token expires, so the browser
 * reconnects with its fresh token (library gap G7: the socket can't change its token).
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AnySpec, Server } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { createRequestListener, handleUpgrade } from '@ayepi/node';
import type { WebSocketServer } from 'ws';
import type { FileRoute } from './serve.ts';

/** The prefix of the web API's HTTP paths. */
export const API_PREFIX = '/api';
/** The browser socket's path. */
export const WS_PATH = '/ws';
/** The system link's path. */
export const LINK_PATH = '/link';
/** The presigned file transfers (`@ayepi/files` mounted on the web API's server). */
export const FILES_PATH = '/_files';
/** The API docs' prefix, when docs are on. */
const DOCS_PREFIX = '/docs/';

/** Whether the web API's server answers a path as it is (no `/api` prefix to take off). */
const passesThrough = (path: string): boolean => path === FILES_PATH || path.startsWith(DOCS_PREFIX);

/** Liveness and readiness, from the lifecycle. */
export interface Health {
  live(): boolean;
  ready(): boolean;
}

/** What the front serves. */
export interface HttpFrontOptions {
  readonly web: Server<AnySpec>;
  readonly link: Server<AnySpec>;
  /** File routes tried in order for requests no server takes. */
  readonly files: readonly FileRoute[];
  readonly health: Health;
  /** WebSocket ping interval. */
  readonly heartbeat: number;
  /** When a browser socket's access token expires (ms since the epoch); undefined for no or a bad token. */
  readonly tokenExpiry: (token: string) => number | undefined;
  /** Close a browser socket this long before its token expires. */
  readonly tokenMargin: number;
  readonly clock: () => number;
  readonly log: Logger;
}

/** An upgrade path, its ayepi socket server and the unlistened `http.Server` it is attached to. */
interface SocketRoute {
  readonly carrier: HttpServer;
  readonly sockets: WebSocketServer;
}

/** The HTTP and WebSocket front. */
export class HttpFront {
  readonly #o: HttpFrontOptions;
  readonly #server: HttpServer;
  readonly #web: (req: IncomingMessage, res: ServerResponse) => void;
  readonly #routes: ReadonlyMap<string, SocketRoute>;
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(options: HttpFrontOptions) {
    this.#o = options;
    this.#web = createRequestListener(options.web);
    this.#routes = new Map([[WS_PATH, this.#socketRoute(options.web)], [LINK_PATH, this.#socketRoute(options.link)]]);
    this.#server = createServer((req, res) => { void this.#request(req, res); });
    this.#server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => { this.#upgrade(req, socket, head); });
  }

  /** Start listening; resolves with the real port. */
  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        const address = this.#server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /** Stop taking new connections; open ones carry on. */
  stopAccepting(): void {
    this.#server.close();
  }

  /** Close every socket and the server. */
  async close(): Promise<void> {
    for (const timer of this.#timers) { clearTimeout(timer); }
    this.#timers.clear();
    for (const route of this.#routes.values()) {
      for (const client of route.sockets.clients) { client.terminate(); }
      await new Promise<void>((resolve) => { route.sockets.close(() => { resolve(); }); });
    }
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) { resolve(); return; }
      this.#server.close(() => { resolve(); });
    });
  }

  #socketRoute(app: Server<AnySpec>): SocketRoute {
    const carrier = createServer();
    return { carrier, sockets: handleUpgrade(app, carrier, { heartbeat: this.#o.heartbeat }) };
  }

  async #request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub');
    const path = url.pathname;
    try {
      if (path === '/healthz' || path === '/readyz') {
        const ok = path === '/healthz' ? this.#o.health.live() : this.#o.health.ready();
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok }));
        return;
      }
      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
        req.url = `${path.slice(API_PREFIX.length) || '/'}${url.search}`;
        this.#web(req, res);
        return;
      }
      if (passesThrough(path)) {
        this.#web(req, res);
        return;
      }
      for (const route of this.#o.files) {
        if (await route.serve(req, res, path)) { return; }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    } catch (error) {
      this.#o.log.error('http.failed', { path }, error);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); }
      res.end();
    }
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://hub');
    const route = this.#routes.get(url.pathname);
    if (route === undefined) {
      socket.destroy();
      return;
    }
    if (url.pathname === WS_PATH) { this.#expireWithToken(socket, url.searchParams.get('access_token')); }
    route.carrier.emit('upgrade', req, socket, head);
  }

  /** Close a browser socket a little before its token expires, so it reconnects with the one the browser has now. */
  #expireWithToken(socket: Duplex, token: string | null): void {
    const expiry = token === null ? undefined : this.#o.tokenExpiry(token);
    if (expiry === undefined) { return; }
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      socket.destroy();
    }, Math.max(0, expiry - this.#o.tokenMargin - this.#o.clock()));
    timer.unref();
    this.#timers.add(timer);
    socket.once('close', () => {
      clearTimeout(timer);
      this.#timers.delete(timer);
    });
  }
}
