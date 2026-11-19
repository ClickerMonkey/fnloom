/**
 * The live systems' pages (item 9): what the hub lists for this person (`systemPages`), for the nav and the page host.
 * Read when the person signs in, and again quietly whenever the hub says what's offered changed (a system came, went,
 * went live, or an admin switched something), so a page joins or leaves the nav without a reload.
 */
import type { SystemName, SystemPageView, UserEvent } from '@harness/core';
import type { HubClient } from '@harness/sdk';
import { computed } from 'vue';
import type { UserEvents } from '../api/notifications.ts';
import { Loaded } from '../state/loaded.ts';
import type { SystemPagesApi } from './api.ts';
import { pageNav } from './logic.ts';

/** What the store needs. */
export interface SystemPagesDeps {
  readonly api: SystemPagesApi;
  readonly events: UserEvents;
  /** The hub client handed to pages (`PageHost.hub`). */
  readonly hub: HubClient;
}

/** The pages the person may open. */
export class SystemPagesStore {
  readonly #deps: SystemPagesDeps;
  #stop: (() => void) | undefined;
  readonly list = new Loaded<SystemPageView[]>();
  /** The nav entries the pages add. */
  readonly nav = computed(() => pageNav(this.list.value.value ?? []));

  constructor(deps: SystemPagesDeps) {
    this.#deps = deps;
  }

  get hub(): HubClient {
    return this.#deps.hub;
  }

  /** Read the pages; `quiet` keeps the loading state off (a refresh). */
  async load(quiet = false): Promise<void> {
    await this.list.load(() => this.#deps.api.systemPages.call({}), 'Couldn’t load the systems’ pages.', quiet);
  }

  /** Read them again quietly, past the caller's cache: after the hub says what's offered changed, or a reconnect. */
  async refresh(): Promise<void> {
    this.#deps.api.systemPages.invalidate();
    await this.load(true);
  }

  /** Follow the hub's changes. */
  start(): void {
    if (this.#stop !== undefined) { return; }
    this.#stop = this.#deps.events((event) => { this.#onEvent(event); });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** Forget them (signed out). */
  clear(): void {
    this.stop();
    this.list.reset();
  }

  /** One page, once the list is loaded. */
  page(system: SystemName, segment: string): SystemPageView | undefined {
    return this.list.value.value?.find((page) => page.system === system && page.segment === segment);
  }

  #onEvent(event: UserEvent): void {
    // a system coming, going or changing status, and anything that changes what is offered, says so this way
    if (event.type === 'capabilities') { void this.refresh(); }
  }
}
