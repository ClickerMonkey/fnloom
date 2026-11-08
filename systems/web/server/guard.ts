/**
 * Which addresses the web system may reach. A fetch (and every redirect, and every request a rendered page makes) is
 * checked: only http and https, and, unless private addresses are allowed, no host that is or resolves to a private,
 * loopback, link-local, shared (CGNAT), multicast or reserved address, so a page can't be used to reach the machine
 * the system runs on or its network.
 */
import { BlockList, isIP } from 'node:net';
import { WebProblem } from './problem.ts';

/** Resolves a hostname to its addresses (every A and AAAA record). An interface so tests answer without DNS. */
export type HostLookup = (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;

/** Ranges no public fetch may reach. */
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;
const PRIVATE_V6 = [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const;

const blocked = new BlockList();
for (const [network, prefix] of PRIVATE_V4) { blocked.addSubnet(network, prefix, 'ipv4'); }
for (const [network, prefix] of PRIVATE_V6) { blocked.addSubnet(network, prefix, 'ipv6'); }

/** The IPv4 address inside an IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible IPv6 address, if it is one. */
function embeddedV4(address: string): string | undefined {
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) { return mapped[1]; }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) { return undefined; }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True when an IP address (v4 or v6) is private, loopback, link-local or otherwise not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) { return blocked.check(bare, 'ipv4'); }
  if (family === 6) {
    const v4 = embeddedV4(bare);
    return v4 === undefined ? blocked.check(bare, 'ipv6') : blocked.check(v4, 'ipv4');
  }
  return false;
}

/** Hostnames that name this machine whatever DNS says. */
function isLocalName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

/** Checks URLs before anything fetches them. */
export interface AddressCheck {
  /** Throws `WebProblem` (`bad-url`, `private-address`) unless the URL may be fetched. */
  check(url: URL, signal?: AbortSignal): Promise<void>;
}

/** The address check for one fetch: http(s) only, and no private addresses unless `allowPrivate`. */
export class AddressGuard implements AddressCheck {
  readonly #lookup: HostLookup;
  readonly #allowPrivate: boolean;

  constructor(lookup: HostLookup, allowPrivate: boolean) {
    this.#lookup = lookup;
    this.#allowPrivate = allowPrivate;
  }

  async check(url: URL, signal?: AbortSignal): Promise<void> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new WebProblem('bad-url', `Only http and https URLs can be fetched, not ${url.protocol.replace(/:$/, '')}.`);
    }
    if (this.#allowPrivate) { return; }
    const host = url.hostname;
    const refuse = () => new WebProblem('private-address', `${host} is a private or local address, which this system may not fetch.`);
    if (isLocalName(host) || isPrivateAddress(host)) { throw refuse(); }
    if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) { return; }
    let addresses: readonly string[];
    try {
      addresses = await this.#lookup(host, signal);
    } catch (error) {
      throw new WebProblem('network', `Couldn't look up ${host}.`, { cause: error });
    }
    if (addresses.some(isPrivateAddress)) { throw refuse(); }
  }
}
