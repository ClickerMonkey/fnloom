/**
 * The network side of a supervised child's grants. Node 22 has no network permission, so a supervisor starts
 * an `AllowlistProxy` for each child and points the child at it (`proxyEnv`: `HTTP(S)_PROXY` and
 * `NODE_USE_ENV_PROXY`, which makes Node's `fetch` and `http(s)` go through it). The proxy lets through only the hosts
 * the system's `grants.network` names (`api.tavily.com`, or `*.googleapis.com` for any name under it) and reports
 * every other host it is asked for, which the supervisor sends to the hub as a `network` refusal.
 *
 * The proxy holds back what goes through Node's proxy support; a raw socket opened on purpose is not proxied, so the
 * supervisor also preloads the socket guard (`NETWORK_GUARD`: `hosted-network-guard.ts` over `socket-guard.ts`), which
 * holds every socket to the proxy and the hub (`guardedEnv` names both). The hub link goes direct (`NO_PROXY`). fs's
 * `SupervisedRunner` (the systems it hosts) and the hub's `ProcessSupervisor` (installed instances) both run children
 * this way.
 */
import { createServer, request as forward, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { NETWORK_ALLOW_VAR, endpointOf, endpointsText, type Endpoint } from './socket-guard.ts';

/**
 * What a supervised child preloads to hold its sockets to its proxy and the hub. `--require`, not `--import`: a preload
 * runs before a loader's `--import`, so Node strips the guard's types itself, and the loader still registers after it.
 */
export const NETWORK_GUARD = fileURLToPath(new URL('./hosted-network-guard.ts', import.meta.url));
/** The guard's files, which a child under Node's permission model must be let read. */
export const NETWORK_GUARD_FILES: readonly string[] = [NETWORK_GUARD, fileURLToPath(new URL('./socket-guard.ts', import.meta.url))];

/** Whether a host is one the patterns allow: the same name, for `*.example.com` any name under `example.com`, and for `*` any host. */
export function hostAllowed(patterns: readonly string[], host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((pattern) => {
    const allowed = pattern.toLowerCase();
    if (allowed === '*') return true;
    return allowed.startsWith('*.') ? name.endsWith(allowed.slice(1)) : name === allowed;
  });
}

/** A host the proxy refused. */
export interface ProxyRefusal {
  readonly host: string;
  readonly port: number;
}

/** What an allowlist proxy lets through, and who hears of what it refuses. */
export interface AllowlistProxyOptions {
  /** The hosts let through at first (`grants.network`, plus the hub's own); `setAllowed` changes them. */
  readonly allow: readonly string[];
  readonly onRefused: (refusal: ProxyRefusal) => void;
  /**
   * Where an allowed target is connected to: the address it was checked at (resolved once, so a name that resolves
   * elsewhere a moment later can't move the connection), or `undefined` to refuse it. Absent, the host as named.
   */
  readonly route?: (target: ProxyRefusal) => Promise<string | undefined>;
}

/** The variables that send a child's `fetch` and `http(s)` through the proxy at `url`, with `direct` hosts not proxied. */
export function proxyEnv(url: string, direct: readonly string[]): Record<string, string> {
  const noProxy = direct.join(',');
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: noProxy, no_proxy: noProxy, NODE_USE_ENV_PROXY: '1' };
}

/**
 * A guarded child's network variables: `proxyEnv` for the proxy at `url` with the `direct` endpoints' hosts not
 * proxied, and the endpoints the preloaded guard lets its sockets reach (the proxy and `direct`).
 */
export function guardedEnv(url: string, direct: readonly Endpoint[]): Record<string, string> {
  return { ...proxyEnv(url, [...new Set(direct.map((endpoint) => endpoint.host))]), [NETWORK_ALLOW_VAR]: endpointsText([endpointOf(url), ...direct]) };
}

/** A child's network gate: listens, can change what it lets through, and is closed once the child is gone. */
export interface NetworkGate {
  /** Start listening; resolves to the proxy URL the child is pointed at. */
  start(): Promise<string>;
  /** Let through `allow` from now on (the grant changed while the child runs); tunnels already open stay. */
  setAllowed(allow: readonly string[]): void;
  close(): Promise<void>;
}

/** The host and port of a `CONNECT` target (`api.example.com:443`, `[::1]:443`). */
function targetOf(authority: string, fallback: number): ProxyRefusal | undefined {
  try {
    const url = new URL(`http://${authority}`);
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port === '' ? fallback : Number(url.port) };
  } catch {
    return undefined;
  }
}

/** An HTTP proxy on 127.0.0.1 that lets through only allowed hosts: `CONNECT` tunnels for https, forwarding for http. */
export class AllowlistProxy implements NetworkGate {
  readonly #options: AllowlistProxyOptions;
  readonly #server: Server;
  readonly #open = new Set<Duplex>();
  #allow: readonly string[];

  constructor(options: AllowlistProxyOptions) {
    this.#options = options;
    this.#allow = options.allow;
    this.#server = createServer((req, res) => { this.#request(req, res); });
    this.#server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => { this.#tunnel(req, client, head); });
  }

  /** Listen on a free port of 127.0.0.1; resolves to the proxy's URL. */
  start(): Promise<string> {
    return new Promise((done, fail) => {
      this.#server.once('error', fail);
      this.#server.listen(0, '127.0.0.1', () => {
        const address: AddressInfo | string | null = this.#server.address();
        if (address === null || typeof address === 'string') { fail(new Error('the proxy has no port')); return; }
        done(`http://127.0.0.1:${String(address.port)}`);
      });
    });
  }

  setAllowed(allow: readonly string[]): void {
    this.#allow = [...allow];
  }

  /** Stop listening and cut every open tunnel. */
  close(): Promise<void> {
    for (const socket of this.#open) { socket.destroy(); }
    return new Promise((done) => { this.#server.close(() => { done(); }); });
  }

  /** Whether a host may be reached; a refused one is reported. */
  #allowed(target: ProxyRefusal): boolean {
    if (hostAllowed(this.#allow, target.host)) { return true; }
    this.#options.onRefused(target);
    return false;
  }

  /** The address to connect an allowed target to (`route`), or `undefined` when it is refused (and reported). */
  async #routed(target: ProxyRefusal): Promise<string | undefined> {
    if (!this.#allowed(target)) { return undefined; }
    const route = this.#options.route;
    if (route === undefined) { return target.host; }
    const address = await route(target).catch(() => undefined);
    if (address === undefined) { this.#options.onRefused(target); }
    return address;
  }

  #keep(socket: Duplex): void {
    this.#open.add(socket);
    socket.once('close', () => { this.#open.delete(socket); });
  }

  #tunnel(req: IncomingMessage, client: Duplex, head: Buffer): void {
    this.#keep(client);
    client.on('error', () => { client.destroy(); });
    const target = targetOf(req.url ?? '', 443);
    if (target === undefined) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    void this.#routed(target).then((address) => {
      if (address === undefined) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
      this.#connectTunnel(client, head, target.port, address);
    });
  }

  /** Open a tunnel for `client` to `address`. */
  #connectTunnel(client: Duplex, head: Buffer, port: number, address: string): void {
    const upstream: Socket = connect(port, address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) { upstream.write(head); }
      upstream.pipe(client);
      client.pipe(upstream);
    });
    this.#keep(upstream);
    upstream.on('error', () => { client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); upstream.destroy(); });
  }

  #request(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port === '' ? 80 : Number(url.port) };
    if (url.protocol !== 'http:') {
      res.writeHead(403).end();
      return;
    }
    void this.#routed(target).then((address) => {
      if (address === undefined) { res.writeHead(403).end(); return; }
      const upstream = forward({ host: address, port: target.port, method: req.method, path: `${url.pathname}${url.search}`, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end(); });
      req.pipe(upstream);
    });
  }
}
