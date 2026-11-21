/**
 * Which addresses the api system may reach: the SDK's address rules (`addressVerdict`, the ones the hub's own fetch and
 * the web system use) on a service's base URL when it is added, on every hop of every request (redirects included)
 * and on its OpenAPI document. A private, loopback or link-local address (or a name that resolves to one) is refused
 * unless an admin allowed it on that service (`ApiService.allowPrivate`).
 */
import type { ApiService } from '@harness/core';
import { addressVerdict, type HostLookup } from '@harness/sdk/server';
import { RequestRefused } from './http.ts';

/** A URL the api system won't reach: a request refused before it is sent. */
export class AddressRefused extends RequestRefused {
  constructor(message: string) {
    super(message);
    this.name = 'AddressRefused';
  }
}

/** Checks URLs before anything is sent to them. */
export interface AddressCheck {
  /** Throws `AddressRefused` unless the URL may be reached. */
  check(url: URL, signal?: AbortSignal): Promise<void>;
}

/** The address check for one service: http(s) only, and no private address unless an admin allowed it on the service. */
export class ServiceGuard implements AddressCheck {
  readonly #lookup: HostLookup;
  readonly #allowPrivate: boolean;

  constructor(lookup: HostLookup, service: Pick<ApiService, 'allowPrivate'>) {
    this.#lookup = lookup;
    this.#allowPrivate = service.allowPrivate;
  }

  async check(url: URL, signal?: AbortSignal): Promise<void> {
    const verdict = await addressVerdict(url, { lookup: this.#lookup, allowPrivate: this.#allowPrivate }, signal);
    if (verdict.ok) { return; }
    switch (verdict.refusal) {
      case 'not-http': throw new AddressRefused(`Only http and https URLs can be reached, not ${url.protocol.replace(/:$/, '')}.`);
      case 'private': throw new AddressRefused(`${url.hostname} is a private or local address. Only an admin can allow that, on the service.`);
      case 'unresolved': throw new AddressRefused(`Couldn't look up ${url.hostname}.`);
    }
  }
}
