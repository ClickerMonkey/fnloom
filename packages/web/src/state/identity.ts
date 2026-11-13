/**
 * The hub as people see it: its display name and version. Loaded before sign-in (the sign-in page names the hub) and
 * kept live by the user channel's `identity` event, so a rename shows in every open tab without a reload. The last
 * name seen is kept on this device, so the brand doesn't flash the default name while the hub answers.
 */
import { DEFAULT_HUB_NAME, HubDisplayName, type HubIdentity, type HubNameSource, type UserEvent } from '@harness/core';
import { computed, shallowRef } from 'vue';
import { BEFORE_SIGN_IN } from '../api/auth.ts';
import type { IdentityApi } from '../api/identity.ts';
import type { UserEvents } from '../api/notifications.ts';
import { Task, type Outcome } from './loaded.ts';
import { readStored, type KeyValueStore } from './persisted.ts';

/** Where the last name seen is kept on this device. */
export const HUB_NAME_KEY = 'harness.hubName';

/** The hub's name and version, live. */
export class IdentityStore {
  readonly #api: IdentityApi;
  readonly #events: UserEvents;
  readonly #store: KeyValueStore | undefined;
  /** The last name seen on this device. */
  readonly #remembered: string | undefined;
  #stop: (() => void) | undefined;
  /** What the hub said; undefined until it answers. */
  readonly identity = shallowRef<HubIdentity | undefined>(undefined);
  /** The name to show: the hub's, else the last one seen on this device, else the default. */
  readonly name = computed<string>(() => this.identity.value?.name ?? this.#remembered ?? DEFAULT_HUB_NAME);
  /** Where the name came from (the admin's setting, the env, the default); undefined until the hub answers. */
  readonly source = computed<HubNameSource | undefined>(() => this.identity.value?.source);
  /** The hub's version; '' until the hub answers. */
  readonly version = computed(() => this.identity.value?.version ?? '');
  /** Saving a new name. */
  readonly saving = new Task();

  constructor(api: IdentityApi, events: UserEvents, store?: KeyValueStore) {
    this.#api = api;
    this.#events = events;
    this.#store = store;
    this.#remembered = store === undefined ? undefined : readStored(store, HUB_NAME_KEY, HubDisplayName);
  }

  /** Ask the hub (over HTTP, so it works before sign-in). A failure keeps the name shown. */
  async load(): Promise<void> {
    try {
      this.#take(await this.#api.identity.call(BEFORE_SIGN_IN));
    } catch {
      // the sign-in page says when the hub is unreachable; the brand keeps the name it has
    }
  }

  /** Follow renames while signed in. */
  start(): void {
    this.#stop ??= this.#events((event) => { this.#onEvent(event); });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** Set the name (admins), or clear the setting (`null`) to go back to the env's or the default. */
  async rename(name: string | null): Promise<Outcome<HubIdentity>> {
    const outcome = await this.saving.run(() => this.#api.setHubName.call({ name }), "Couldn't save the name.");
    if (outcome.ok) { this.#take(outcome.value); }
    return outcome;
  }

  #onEvent(event: UserEvent): void {
    if (event.type === 'identity') { this.#take(event.identity); }
  }

  #take(identity: HubIdentity): void {
    this.identity.value = identity;
    try {
      this.#store?.setItem(HUB_NAME_KEY, JSON.stringify(identity.name));
    } catch {
      // storage full or blocked: the name still shows, it just isn't remembered on this device
    }
  }
}

/** What the Settings field says about where the name in use came from. */
export const NAME_SOURCE_WORDS = {
  setting: 'Set here.',
  env: 'From the hub’s HARNESS_NAME setting.',
  default: 'The default name.',
} as const satisfies Record<HubNameSource, string>;

/** Check a typed name the way the hub will: the name to save, or why it can't be. */
export function checkHubName(text: string): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: string } {
  const checked = HubDisplayName.safeParse(text);
  if (checked.success) { return { ok: true, name: checked.data }; }
  return { ok: false, problem: text.trim() === '' ? 'Give the hub a name.' : 'Keep it to one line of at most 40 characters.' };
}
