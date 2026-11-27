/**
 * The hub's https, for Settings: whether it is on, the secure address on each network of the hub's computer, the
 * hub's own authority (to install on a phone) and the admin's switch. Loaded when Settings asks.
 */
import { AUTHORITY_PATHS, type HttpsView } from '@harness/core';
import { computed, shallowRef } from 'vue';
import type { HttpsApi } from '../api/https.ts';
import { Task, type Outcome } from './loaded.ts';

/** The hub's https and the admin's switch. */
export class HttpsStore {
  readonly #api: HttpsApi;
  /** What the hub said; undefined until it answers. */
  readonly view = shallowRef<HttpsView | undefined>(undefined);
  /** Loading it. */
  readonly loading = new Task();
  /** Switching it. */
  readonly saving = new Task();
  /** The authority to install, when the hub has one of its own and https is on. */
  readonly authority = computed(() => (this.view.value?.on === true && this.view.value.source === 'own' ? AUTHORITY_PATHS.der : undefined));

  constructor(api: HttpsApi) {
    this.#api = api;
  }

  /** Ask the hub. */
  async load(): Promise<void> {
    const outcome = await this.loading.run(() => this.#api.https.call({}), "Couldn't read the hub's secure connection.");
    if (outcome.ok) { this.view.value = outcome.value; }
  }

  /** Switch it (admins). */
  async set(on: boolean): Promise<Outcome<HttpsView>> {
    const outcome = await this.saving.run(() => this.#api.setHttps.call({ on }), "Couldn't save the setting.");
    if (outcome.ok) { this.view.value = outcome.value; }
    return outcome;
  }
}

/** A link's `http://` twin on the same port (the hub answers both), where a phone downloads the authority before it trusts https. */
export function plainTwin(link: string, path: string): string {
  const url = new URL(path, link);
  url.protocol = 'http:';
  return url.toString();
}
