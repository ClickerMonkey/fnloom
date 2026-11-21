/**
 * The admin's outside-images setting (`core/urls.ts`): whether markdown images from outside the hub load at once or
 * wait for a click. Loaded on sign-in; until the hub answers (or when it can't), images wait: the secure default.
 */
import { OUTSIDE_IMAGES_DEFAULT, type OutsideImages, type OutsideImagesView } from '@harness/core';
import { computed, shallowRef } from 'vue';
import type { OutsideImagesApi } from '../api/outside-images.ts';
import { Task, type Outcome } from './loaded.ts';

/** The setting, for every chat, and the admin's switch. */
export class OutsideImagesStore {
  readonly #api: OutsideImagesApi;
  /** What the hub said; undefined until it answers. */
  readonly view = shallowRef<OutsideImagesView | undefined>(undefined);
  /** The setting in use. */
  readonly value = computed<OutsideImages>(() => this.view.value?.value ?? OUTSIDE_IMAGES_DEFAULT);
  /** Saving a new choice. */
  readonly saving = new Task();

  constructor(api: OutsideImagesApi) {
    this.#api = api;
  }

  /** Ask the hub. A failure keeps the setting shown (the default until it has answered once). */
  async load(): Promise<void> {
    try {
      this.view.value = await this.#api.outsideImages.call({});
    } catch {
      // images keep waiting for a click
    }
  }

  /** Set it (admins). */
  async set(value: OutsideImages): Promise<Outcome<OutsideImagesView>> {
    const outcome = await this.saving.run(() => this.#api.setOutsideImages.call({ value }), "Couldn't save the setting.");
    if (outcome.ok) { this.view.value = outcome.value; }
    return outcome;
  }

  /** Forget it on sign-out, back to the default. */
  clear(): void {
    this.view.value = undefined;
  }
}
