/**
 * Which addresses a fetch made for someone else may reach, and redirects followed by hand so every hop is checked.
 * The hub's own URL imports and the web system both fetch through these, so one set of rules applies whichever of
 * them does the fetching: only http and https, and, unless private addresses are allowed, no host that is or resolves
 * to a private, loopback, link-local, shared (CGNAT), benchmarking, documentation, multicast or reserved address, and
 * no name that means this machine (`localhost`, `*.local`, `*.internal`).
 *
 * The check runs before each request; the connection itself resolves the name again, so a name whose DNS answer
 * changes between the two (DNS rebinding) is not caught here. Pinning the checked address for the connection belongs
 * in `@aeye/resources`' url loader (a recorded library ask).
 */
import dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { FetchFn } from '@aeye/resources';

/** Resolves a hostname to its addresses (every A and AAAA record). A seam, so tests answer without DNS. */
export type HostLookup = (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;

/** The machine's resolver: every address, in the order DNS gave them. */
export const systemLookup: HostLookup = async (hostname) => (await dns.lookup(hostname, { all: true, order: 'verbatim' })).map((found) => found.address);

/** IPv4 ranges no public fetch may reach. */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;

/** IPv6 ranges no public fetch may reach. */
const BLOCKED_V6 = [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const;

const blocked = new BlockList();
for (const [network, prefix] of BLOCKED_V4) { blocked.addSubnet(network, prefix, 'ipv4'); }
for (const [network, prefix] of BLOCKED_V6) { blocked.addSubnet(network, prefix, 'ipv6'); }

/** An address without the brackets a URL host puts around IPv6. */
function unbracketed(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

/** The IPv4 address inside an IPv4-mapped (`::ffff:a.b.c.d`, `::ffff:7f00:1`) or IPv4-compatible IPv6 address, if it is one. */
function embeddedV4(address: string): string | undefined {
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (dotted !== undefined) { return dotted; }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) { return undefined; }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True when an IP address (v4 or v6, bracketed or not) is not on the public internet. Names are not addresses: false. */
export function isPrivateAddress(address: string): boolean {
  const bare = unbracketed(address);
  const family = isIP(bare);
  if (family === 4) { return blocked.check(bare, 'ipv4'); }
  if (family === 6) {
    const v4 = embeddedV4(bare);
    return v4 === undefined ? blocked.check(bare, 'ipv6') : blocked.check(v4, 'ipv4');
  }
  return false;
}

/** True when a hostname names this machine or its network whatever DNS says. */
export function isLocalName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

/** True when a link URL is plain `ws:` to another machine, so whatever rides it (an auto-pair secret too) can be read on the way. */
export function isPlainOffMachine(url: string): boolean {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== 'ws:' && parsed?.protocol !== 'http:') { return false; }
  const host = unbracketed(parsed.hostname).toLowerCase();
  return !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || (isIP(host) === 4 && host.startsWith('127.')));
}

/** Why a URL may not be fetched: not http(s); a private address or local name; a name that didn't resolve. */
export type AddressRefusal = 'not-http' | 'private' | 'unresolved';

/** Whether a URL may be fetched; a refusal says why (and, for `unresolved`, what the lookup threw). */
export type AddressVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: AddressRefusal; readonly cause?: unknown };

/** What an address check needs. */
export interface AddressRules {
  readonly lookup: HostLookup;
  /** Let private addresses and local names through (http and https are still the only schemes). */
  readonly allowPrivate: boolean;
}

/**
 * Whether `url` may be fetched under `rules`. A literal address and a local name are judged without DNS; a name is
 * refused when any of its addresses is private, when it resolves to nothing, or when the lookup fails.
 */
export async function addressVerdict(url: URL, rules: AddressRules, signal?: AbortSignal): Promise<AddressVerdict> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { return { ok: false, refusal: 'not-http' }; }
  if (rules.allowPrivate) { return { ok: true }; }
  const host = url.hostname;
  if (isLocalName(host) || isPrivateAddress(host)) { return { ok: false, refusal: 'private' }; }
  if (isIP(unbracketed(host)) !== 0) { return { ok: true }; }
  let addresses: readonly string[];
  try {
    addresses = await rules.lookup(host, signal);
  } catch (cause) {
    return { ok: false, refusal: 'unresolved', cause };
  }
  if (addresses.length === 0) { return { ok: false, refusal: 'unresolved' }; }
  // a lookup only gives addresses; anything else is treated as unsafe
  return addresses.some((address) => isIP(unbracketed(address)) === 0 || isPrivateAddress(address)) ? { ok: false, refusal: 'private' } : { ok: true };
}

/** The statuses that redirect. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The errors a redirect chain fails with, so each caller names them its own way. */
export interface RedirectProblems {
  /** A redirect without a location that parses against `at`. */
  noLocation(at: URL): unknown;
  /** More than `limit` redirects from `start`. */
  tooMany(start: URL, limit: number): unknown;
  /** What to throw when the fetch at `at` threw `error` (default: `error` itself). */
  failed?(error: unknown, at: URL): unknown;
}

/** How `followRedirects` fetches. */
export interface RedirectOptions {
  /** The fetch underneath; it is always called with `redirect: 'manual'`. */
  readonly fetch: FetchFn;
  /** Checked before every hop is requested; throws to refuse it. */
  check(url: URL, signal?: AbortSignal): Promise<void>;
  /** The most redirects followed. */
  readonly redirects: number;
  readonly problems: RedirectProblems;
}

/** The response a redirect chain ended at (not a redirect), and the URL it came from. */
export interface FollowedResponse {
  readonly response: Response;
  readonly url: URL;
}

/** Fetch `input`, following redirects by hand: every hop is checked first, and a redirect's body is dropped. */
export async function followRedirects(input: string, init: RequestInit, options: RedirectOptions): Promise<FollowedResponse> {
  const start = new URL(input);
  const signal = init.signal ?? undefined;
  let url = start;
  for (let hop = 0; ; hop += 1) {
    await options.check(url, signal);
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await options.fetch(url.href, { ...init, redirect: 'manual' });
    } catch (error) {
      throw options.problems.failed === undefined ? error : options.problems.failed(error, url);
    }
    if (!REDIRECT_STATUSES.has(response.status)) { return { response, url }; }
    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (location === null || !URL.canParse(location, url)) { throw options.problems.noLocation(url); }
    if (hop >= options.redirects) { throw options.problems.tooMany(start, options.redirects); }
    url = new URL(location, url);
  }
}
