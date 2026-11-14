/**
 * The network side of a sandboxed child, loaded first by the modules that use it (fs's `network-guard.ts` for an
 * unapproved folder's tests, through `@harness/sdk/server/socket-guard`; `hosted-network-guard.ts` beside this for a
 * supervised system, whether fs hosts it or the hub's supervisor runs it). Node 22's permission model limits the
 * disk, child processes, workers and addons but not the network, and `HTTP(S)_PROXY` only steers the clients that
 * honour it (a raw `net.connect`, or `http.get` with an agent of its own, goes straight out). So this guards the
 * sockets themselves: TCP and TLS (net, tls, http, https, http2, fetch and WebSocket all connect through
 * `net.Socket.prototype.connect`) reach only the endpoints allowed, by host and port; pipes, servers, UDP and DNS
 * queries are shut, and a name is looked up only when it is an allowed host. Each replacement is fixed in place
 * (neither writable nor configurable) and the originals are kept only in this module's closures, so the guarded code
 * can't put them back; the permission model already denies `process.binding`, the way around these modules.
 *
 * Plain TypeScript Node can strip by itself: the tests' processes load this with no TypeScript loader.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

/** One place a guarded child may connect to. */
export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

/** What a refused attempt was: a connection to a host, to a local pipe, a server, UDP, or a name lookup or query. */
export type Refused = 'connect' | 'pipe' | 'listen' | 'udp' | 'dns';

/** What a guard lets through, and the message of the error everything else fails with. */
export interface GuardOptions {
  readonly allow: readonly Endpoint[];
  /** The error message for a refused attempt (`target` is `host:port`, a pipe's path, or what was asked for). */
  readonly refused: (target: string, kind: Refused) => string;
}

/** A host as compared: lower case, no brackets around an IPv6 address, no trailing dot. */
export function hostKey(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** An endpoint as `host:port`, the form a refusal names it by. */
export function endpointText(endpoint: Endpoint): string {
  return `${hostKey(endpoint.host)}:${String(endpoint.port)}`;
}

/** The endpoint of a URL (`http://127.0.0.1:4300` → 127.0.0.1:4300), with the scheme's port when it names none. */
export function endpointOf(url: string): Endpoint {
  const parsed = new URL(url);
  const port = parsed.port === '' ? (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80) : Number(parsed.port);
  return { host: hostKey(parsed.hostname), port };
}

/** Endpoints as one environment value (`host:port,host:port`), and back; malformed parts are dropped. */
export function endpointsText(endpoints: readonly Endpoint[]): string {
  return endpoints.map(endpointText).join(',');
}
export function parseEndpoints(text: string | undefined): Endpoint[] {
  if (text === undefined) { return []; }
  return text.split(',').flatMap((part) => {
    const at = part.lastIndexOf(':');
    const port = Number(part.slice(at + 1));
    return at <= 0 || !Number.isInteger(port) || port <= 0 ? [] : [{ host: hostKey(part.slice(0, at)), port }];
  });
}

/** Where a `Socket.prototype.connect` call goes, read the way `net` reads it: a truthy `path` is a pipe. */
type Target = { readonly endpoint: Endpoint } | { readonly pipe: string } | { readonly unknown: string };

/** Why a guarded call is refused (what was asked for, and what kind of attempt), or `undefined` when it may go. */
type Verdict = { readonly target: string; readonly kind: Refused } | undefined;

function field(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function targetOf(args: readonly unknown[]): Target {
  const head = args[0];
  // `net.connect` hands the socket its arguments already normalized, as an array whose first item is the options
  const first: unknown = Array.isArray(head) ? head[0] : head;
  if (typeof first === 'object' && first !== null) {
    const path = field(first, 'path');
    if (typeof path === 'string' && path !== '') { return { pipe: path }; }
    const host = field(first, 'host');
    const port = Number(field(first, 'port'));
    return Number.isInteger(port) ? { endpoint: { host: hostKey(typeof host === 'string' && host !== '' ? host : 'localhost'), port } } : { unknown: String(field(first, 'port')) };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = args[1];
    return { endpoint: { host: hostKey(typeof host === 'string' && host !== '' ? host : 'localhost'), port: Number(first) } };
  }
  return typeof first === 'string' ? { pipe: first } : { unknown: String(first) };
}

/** Replace `target[name]` for good with `value`. */
function fix(target: object, name: string, value: (this: unknown, ...args: unknown[]) => unknown): void {
  Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
}

/** Replace `target[name]` for good with a function that runs the original only when `allowed` says so. */
function gate(target: object, name: string, allowed: (args: readonly unknown[]) => Verdict, refused: GuardOptions['refused']): void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== 'function') { return; }
  fix(target, name, function guarded(this: unknown, ...args: unknown[]): unknown {
    const denied = allowed(args);
    if (denied !== undefined) { throw new Error(refused(denied.target, denied.kind)); }
    const result: unknown = Reflect.apply(original, this, args);
    return result;
  });
}

/** Replace `target[name]` for good with a function that always throws. */
function shut(target: object, name: string, kind: Refused, refused: GuardOptions['refused']): void {
  fix(target, name, () => { throw new Error(refused(name, kind)); });
}

/** The names on `target` that query DNS servers (`resolve*`, `reverse`); `lookup` asks the OS and is gated by host. */
function dnsQueries(target: object): string[] {
  return Object.getOwnPropertyNames(target).filter((name) => /^(lookupService|resolve|reverse)/.test(name));
}

/** Guard this process's network (see the module doc). Call once, before any other code runs. */
export function guardNetwork(options: GuardOptions): void {
  const endpoints = new Set(options.allow.map(endpointText));
  const hosts = new Set(options.allow.map((endpoint) => hostKey(endpoint.host)));
  const { refused } = options;
  gate(net.Socket.prototype, 'connect', (args) => {
    const target = targetOf(args);
    if ('endpoint' in target) { return endpoints.has(endpointText(target.endpoint)) ? undefined : { target: endpointText(target.endpoint), kind: 'connect' }; }
    return 'pipe' in target ? { target: target.pipe, kind: 'pipe' } : { target: target.unknown, kind: 'connect' };
  }, refused);
  shut(net.Server.prototype, 'listen', 'listen', refused);
  for (const name of ['bind', 'connect', 'send'] as const) { shut(dgram.Socket.prototype, name, 'udp', refused); }
  const lookupAllowed = (args: readonly unknown[]): Verdict => {
    const host = args[0];
    return typeof host === 'string' && hosts.has(hostKey(host)) ? undefined : { target: String(host), kind: 'dns' };
  };
  for (const target of [dns, dns.promises]) {
    gate(target, 'lookup', lookupAllowed, refused);
    for (const name of dnsQueries(target)) { shut(target, name, 'dns', refused); }
  }
  for (const target of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of [...dnsQueries(target), 'lookup']) { if (name in target) { shut(target, name, 'dns', refused); } }
  }
  // `import { lookup } from 'node:dns'` reads the module's ESM view, which follows these changes only once synced
  syncBuiltinESMExports();
}

/** The variable a supervisor names a child's allowed endpoints in (`endpointsText`), for `hosted-network-guard.ts`. */
export const NETWORK_ALLOW_VAR = 'HARNESS_NETWORK_ALLOW';

/** The start of the line a guarded system prints for a refused attempt, followed by what was asked for. */
const NETWORK_REFUSED = 'harness.network.refused ';

/** The line printed for a refused attempt (`host:port`, or a pipe's path). */
export function networkRefusedLine(target: string): string {
  return `${NETWORK_REFUSED}${target}`;
}

/** What a printed line says was refused, when it is a refusal line. */
export function refusedOfLine(line: string): string | undefined {
  return line.startsWith(NETWORK_REFUSED) ? line.slice(NETWORK_REFUSED.length).trim() : undefined;
}
