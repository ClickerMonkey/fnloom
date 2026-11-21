/**
 * Where a request comes from: the one rule the hub's per-address limits use (sign-in, pairing). The socket's address
 * (`@ayepi/node`'s `remoteAddress`) unless the admin says proxies are in front of the hub (`ProxyTrust`); then the
 * address the outermost trusted proxy saw, read from the end of `X-Forwarded-For`, since a proxy appends and anything
 * before what it added is the client's own claim.
 */
import { isIPv6 } from 'node:net';
import { remoteAddress } from '@ayepi/node';
import { DEFAULT_PROXY_TRUST, PROXY_TRUST_OPTION, type ProxyTrust } from '@harness/core';
import type { HubStore } from '../store/index.ts';

/** The address of a request whose socket isn't known (an in-process call). */
export const UNKNOWN_ADDRESS = 'unknown';

/** The admin's proxy setting, or no proxy until one is set. */
export async function proxyTrust(store: HubStore): Promise<ProxyTrust> {
  const row = await store.table('hubOptions').get(PROXY_TRUST_OPTION);
  return row?.key === PROXY_TRUST_OPTION ? row.value : DEFAULT_PROXY_TRUST;
}

/**
 * The client's address from the socket's and the `X-Forwarded-For` header's: the socket's with no trusted proxy,
 * otherwise the entry `trust.proxies` from the end (the socket's when the header has fewer).
 */
export function addressFrom(socket: string | undefined, forwardedFor: string | null | undefined, trust: ProxyTrust): string {
  const own = normalAddress(socket) ?? UNKNOWN_ADDRESS;
  if (trust.proxies === 0 || forwardedFor === null || forwardedFor === undefined) return own;
  const hops = forwardedFor.split(',').map((part) => part.trim()).filter((part) => part !== '');
  return normalAddress(hops[hops.length - trust.proxies]) ?? own;
}

/** Where a request the hub's HTTP front (or its socket upgrade) received comes from, by the admin's proxy setting. */
export async function clientAddress(req: Request, store: HubStore): Promise<string> {
  return addressFrom(remoteAddress(req), req.headers.get('x-forwarded-for'), await proxyTrust(store));
}

/** An address as one key: an IPv4-mapped IPv6 address as its IPv4 form, lower case; undefined when empty. */
function normalAddress(address: string | undefined): string | undefined {
  const trimmed = address?.trim().toLowerCase();
  if (trimmed === undefined || trimmed === '') return undefined;
  return trimmed.startsWith('::ffff:') && trimmed.includes('.') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/**
 * An address as a rate-limit key: an IPv6 address as its /64 network, since one home or server is handed a whole
 * /64 and could otherwise spread its tries over as many addresses as it likes; anything else as it is.
 */
export function limitKey(address: string): string {
  if (!isIPv6(address)) return address;
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}
