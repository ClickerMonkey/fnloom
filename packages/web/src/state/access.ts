/**
 * Visibility: whether the hub has more than one person (the controls show only then), a thing's visibility, and
 * changing it. Fetched once per target as a page shows it; a change answers with the stored view.
 */
import type { AccessTarget, AccessView, ShareRule } from '@harness/core';
import { ref, type Ref } from 'vue';
import type { PickerApi } from '../api/pickers.ts';
import type { Outcome } from '../ui/types.ts';
import { Loaded, Task } from './loaded.ts';

/** The visibility callers the store uses. */
export type AccessApi = Pick<PickerApi, 'accessInfo' | 'access' | 'setAccess'>;

/** Whether the hub has more than one person, and every visibility a page asks for. */
export class AccessStore {
  readonly #api: AccessApi;
  /** More than one person on the hub: false until known, so a single-person hub never flashes the controls. */
  readonly multiUser: Ref<boolean> = ref(false);
  readonly saving = new Task();
  #asked = false;

  constructor(api: AccessApi) {
    this.#api = api;
  }

  /** Ask once whether the hub has more than one person. */
  async load(): Promise<void> {
    if (this.#asked) { return; }
    this.#asked = true;
    try {
      this.multiUser.value = (await this.#api.accessInfo.call({})).multiUser;
    } catch {
      this.#asked = false;
    }
  }

  /** A target's visibility, loaded now. */
  view(target: AccessTarget): Loaded<AccessView> {
    const view = new Loaded<AccessView>();
    void view.load(async () => {
      const [found] = await this.#api.access.call({ targets: [target] });
      if (found === undefined) { throw new Error('The hub did not say who can use this.'); }
      return found;
    }, 'Couldn’t load who can use this.');
    return view;
  }

  /** Change a target's visibility; answers the stored view. */
  async set(target: AccessTarget, rule: ShareRule): Promise<Outcome<AccessView>> {
    return this.saving.run(() => this.#api.setAccess.call({ target, sharing: rule }), 'Couldn’t change who can use this.');
  }
}
