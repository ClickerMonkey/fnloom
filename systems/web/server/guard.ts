/**
 * Which addresses the web system may reach. A fetch (and every redirect, and every request a rendered page makes) is
 * checked with the SDK's address rules (`addressVerdict`, the same rules the hub's own fetch uses), each refusal a
 * `WebProblem`, so a page can't be used to reach the machine the system runs on or its network.
 */
import { addressVerdict, type HostLookup } from '@harness/sdk/server';
import { WebProblem } from './problem.ts';

/** Checks URLs before anything fetches them. */
export interface AddressCheck {
  /** Throws `WebProblem` (`bad-url`, `private-address`, `network`) unless the URL may be fetched. */
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
    const verdict = await addressVerdict(url, { lookup: this.#lookup, allowPrivate: this.#allowPrivate }, signal);
    if (verdict.ok) { return; }
    switch (verdict.refusal) {
      case 'not-http': throw new WebProblem('bad-url', `Only http and https URLs can be fetched, not ${url.protocol.replace(/:$/, '')}.`);
      case 'private': throw new WebProblem('private-address', `${url.hostname} is a private or local address, which this system may not fetch.`);
      case 'unresolved': throw new WebProblem('network', `Couldn't look up ${url.hostname}.`, { cause: verdict.cause });
    }
  }
}
