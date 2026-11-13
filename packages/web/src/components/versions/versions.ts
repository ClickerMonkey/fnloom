/**
 * Version history for any item a system declares or adds while running (build 8): fns, types, context items, kinds,
 * commands and the rest of a system's parts. The hub keeps one numbered version per change; this is the state of one
 * item's history (a page at a time, newest first) and the words for it. A page provides where the history is read
 * from (`ITEM_VERSIONS`), so the history view knows nothing of the hub.
 */
import type { ItemSection, ItemVersionRecord, ItemVersionsPage, ItemVersionsQuery, SystemName } from '@harness/core';
import { ref, shallowRef, type InjectionKey } from 'vue';
import { problemText } from '../../state/problems.ts';

/** How many versions a page holds. */
export const ITEM_VERSIONS_PAGE = 20;

/** Reads one page of an item's history. */
export type ItemVersionsSource = (query: ItemVersionsQuery) => Promise<ItemVersionsPage>;

/** Where the app provides the history source. */
export const ITEM_VERSIONS: InjectionKey<ItemVersionsSource> = Symbol('item-versions');

/** The item a history is of. */
export interface ItemKey {
  readonly system: SystemName;
  readonly section: ItemSection;
  readonly name: string;
}

/** What a version did, in words. */
export const ITEM_CHANGE_WORDS = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const satisfies Record<ItemVersionRecord['change'], string>;

/** One item's history, loaded a page at a time. */
export class ItemHistory {
  readonly #source: ItemVersionsSource;
  #item: ItemKey | undefined;
  #generation = 0;
  readonly versions = shallowRef<readonly ItemVersionRecord[]>([]);
  readonly next = ref<string | undefined>(undefined);
  readonly loading = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');

  constructor(source: ItemVersionsSource) {
    this.#source = source;
  }

  /** Show an item's newest versions. */
  async load(item: ItemKey): Promise<void> {
    this.#item = item;
    this.versions.value = [];
    this.next.value = undefined;
    this.loaded.value = false;
    await this.#page(undefined);
  }

  /** The next older page. */
  async more(): Promise<void> {
    if (this.next.value !== undefined) { await this.#page(this.next.value); }
  }

  async #page(cursor: string | undefined): Promise<void> {
    const item = this.#item;
    if (item === undefined) { return; }
    const generation = ++this.#generation;
    this.loading.value = true;
    this.problem.value = '';
    try {
      const page = await this.#source({ ...item, limit: ITEM_VERSIONS_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      if (generation !== this.#generation) { return; }
      this.versions.value = cursor === undefined ? page.items : [...this.versions.value, ...page.items];
      this.next.value = page.cursor;
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't load its history."); }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }
}
