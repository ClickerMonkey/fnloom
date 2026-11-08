/**
 * Finding resources by words for a picker (making context from a resource, linking one): the first few matches of the
 * hub's resource search, a newer search superseding one still on its way, apart from the browser's own list.
 */
import type { ResourceRecord } from '@harness/core';
import { Loaded } from '../../state/loaded.ts';
import type { ResourcesApi } from '../api/resources.ts';

/** How many matches a picker shows. */
export const FOUND_LIMIT = 8;

/** A picker's resource search. */
export class ResourceSearchStore {
  readonly #api: Pick<ResourcesApi, 'find'>;
  /** The matches of the last search; empty before one. */
  readonly found = new Loaded<readonly ResourceRecord[]>();

  constructor(api: Pick<ResourcesApi, 'find'>) {
    this.#api = api;
  }

  /** Search for `text`; blank words clear the matches. */
  async search(text: string): Promise<void> {
    const words = text.trim();
    if (words === '') { this.found.reset(); return; }
    await this.found.load(async () => (await this.#api.find.call({ search: words, limit: FOUND_LIMIT })).items, "Couldn't search resources.");
  }
}
