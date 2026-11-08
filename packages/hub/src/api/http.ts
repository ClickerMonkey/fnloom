/**
 * The hub's one port. HTTP: `/api/*` is the web API (its ayepi server, with the prefix taken off), `/_files` the
 * presigned files, `/docs/*` the API docs when on, `/healthz` and `/readyz` the health checks, `/mcp/*` the hub MCPs
 * (Streamable HTTP, JSON or SSE from one path), `/clients/*` systems' client builds, and everything else the built
 * web app. WebSocket: `/ws` for browsers and `/link` for systems, each
 * on its own ayepi server, routed by `@ayepi/node`'s `routeUpgrades`. A browser socket is closed shortly before its
 * access token expires (`closeAt`), so the browser reconnects with the fresh token it holds by then.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AnySpec, Server } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { createRequestListener, routeUpgrades, upgradeHandler, type UpgradeHandler } from '@ayepi/node';
import type { FileRoute } from './serve.ts';

/** The prefix of the web API's HTTP paths. */
export const API_PREFIX = '/api';
/** The browser socket's path. */
export const WS_PATH = '/ws';
/** The system link's path. */
export const LINK_PATH = '/link';
/** The presigned file transfers (`@ayepi/files` mounted on the web API's server). */
export const FILES_PATH = '/_files';
/** Where hub MCPs are served (`/mcp/<slug>`). */
export const MCP_PATH = '/mcp';
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
  /** The hub MCPs' web-standard handler (`McpEndpoints.handle`). */
  readonly mcp: { fetch(request: Request): Promise<Response> };
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

/** The HTTP and WebSocket front. */
export class HttpFront {
  readonly #o: HttpFrontOptions;
  readonly #server: HttpServer;
  readonly #web: (req: IncomingMessage, res: ServerResponse) => void;
  readonly #mcp: (req: IncomingMessage, res: ServerResponse) => void;
  readonly #sockets: readonly UpgradeHandler[];

  constructor(options: HttpFrontOptions) {
    this.#o = options;
    this.#web = createRequestListener(options.web);
    this.#mcp = createRequestListener(options.mcp);
    const browser = upgradeHandler(options.web, { heartbeat: options.heartbeat, clock: options.clock, closeAt: (req) => this.#closeAt(req) });
    const systems = upgradeHandler(options.link, { heartbeat: options.heartbeat });
    this.#sockets = [browser, systems];
    this.#server = createServer((req, res) => { void this.#request(req, res); });
    routeUpgrades(this.#server, { [WS_PATH]: browser, [LINK_PATH]: systems });
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
    for (const { sockets } of this.#sockets) {
      for (const client of sockets.clients) { client.terminate(); }
      await new Promise<void>((resolve) => { sockets.close(() => { resolve(); }); });
    }
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) { resolve(); return; }
      this.#server.close(() => { resolve(); });
    });
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
      if (path === MCP_PATH || path.startsWith(`${MCP_PATH}/`)) {
        this.#mcp(req, res);
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

  /**
   * When a browser socket closes: a little before the access token it opened with expires; at once when that token has
   * already expired (or isn't the hub's), so the browser reconnects with the one it refreshes; never without one.
   */
  #closeAt(req: Request): number | undefined {
    const token = new URL(req.url).searchParams.get('access_token');
    if (token === null || token === '') { return undefined; }
    const expiry = this.#o.tokenExpiry(token);
    return expiry === undefined ? this.#o.clock() : expiry - this.#o.tokenMargin;
  }
}
