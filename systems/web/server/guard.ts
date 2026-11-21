/**
 * Which addresses the web system may reach. A fetch (and every redirect, and every request a rendered page makes) is
 * checked with the SDK's address rules (`addressVerdict`, the same rules the hub's own fetch uses), each refusal a
 * `WebProblem`, so a page can't be used to reach the machine the system runs on or its network.
 */
import { isIP } from 'node:net';
import { addressVerdict, type HostLookup } from '@harness/sdk/server';
import { WebProblem } from './problem.ts';

/** Checks URLs before anything fetches them. */
export interface AddressCheck {
  /** Throws `WebProblem` (`bad-url`, `private-address`, `network`) unless the URL may be fetched. */
  check(url: URL, signal?: AbortSignal): Promise<void>;
  /**
   * The address to connect to for a host, checked as `check` does: what a connection then goes to, so a name that
   * resolves elsewhere a moment later (DNS rebinding) can't move it. Throws `WebProblem` as `check` does.
   */
  address(host: string, signal?: AbortSignal): Promise<string>;
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
    await this.#vetted(url, signal);
  }

  async address(host: string, signal?: AbortSignal): Promise<string> {
    const given = host.replace(/^\[|\]$/g, '');
    const url = URL.parse(`http://${given.includes(':') ? `[${given}]` : given}/`);
    if (url === null) { throw new WebProblem('bad-url', `${given} isn't a host name.`); }
    // the host as the URL reads it: a number form such as `0x7f.1` or `2130706433` is the address it means
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    const found = await this.#vetted(url, signal);
    if (isIP(bare) !== 0) { return bare; }
    const address = (found ?? await this.#lookup(bare, signal))[0];
    if (address === undefined) { throw new WebProblem('network', `Couldn't look up ${bare}.`); }
    return address;
  }

  /** Check a URL with the SDK's rules; the addresses its host was checked at, when it was looked up. */
  async #vetted(url: URL, signal?: AbortSignal): Promise<readonly string[] | undefined> {
    let found: readonly string[] | undefined;
    const lookup: HostLookup = async (name, given) => { found = await this.#lookup(name, given); return found; };
    const verdict = await addressVerdict(url, { lookup, allowPrivate: this.#allowPrivate }, signal);
    if (verdict.ok) { return found; }
    switch (verdict.refusal) {
      case 'not-http': throw new WebProblem('bad-url', `Only http and https URLs can be fetched, not ${url.protocol.replace(/:$/, '')}.`);
      case 'private': throw new WebProblem('private-address', `${url.hostname} is a private or local address, which this system may not fetch.`);
      case 'unresolved': throw new WebProblem('network', `Couldn't look up ${url.hostname}.`, { cause: verdict.cause });
    }
  }
}
