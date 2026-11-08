/**
 * Suggestions while writing: once typing pauses on a draft long enough to mean something, the hub's index is asked
 * which fns and context match it by meaning, and the composer shows them as a faint row. The pause and "only the
 * latest ask counts" are the `suggest` caller's own policy (`debounce` and `lastOnly`, see `chat/api.ts`): this store
 * only asks and shows what comes back. A draft too short to ask about cancels the pending ask; sending clears the row.
 */
import type { SessionId, Suggestion } from '@harness/core';
import { ref, shallowRef } from 'vue';
import { isSuperseded } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** Which drafts to ask about (at least this long), and how many suggestions to ask for. */
export interface SuggestSettings {
  readonly minLength: number;
  readonly limit: number;
}

export const SUGGEST: SuggestSettings = { minLength: 12, limit: 6 };

/** Suggestions for the draft of one session. */
export class DraftSuggestions {
  readonly #api: Pick<ChatApi, 'suggest'>;
  readonly #session: SessionId;
  readonly #settings: SuggestSettings;
  /** The draft the shown suggestions (or the ask on its way) are for. */
  #asked = '';

  readonly items = shallowRef<readonly Suggestion[]>([]);
  readonly loading = ref(false);

  constructor(api: Pick<ChatApi, 'suggest'>, session: SessionId, settings: SuggestSettings = SUGGEST) {
    this.#api = api;
    this.#session = session;
    this.#settings = settings;
  }

  /** The draft changed. */
  update(text: string): void {
    const draft = text.trim();
    if (draft.length < this.#settings.minLength || draft.startsWith('/') || draft.startsWith('!')) {
      this.clear();
      return;
    }
    if (draft === this.#asked) { return; }
    void this.#ask(draft);
  }

  clear(): void {
    this.#api.suggest.cancel();
    this.items.value = [];
    this.loading.value = false;
    this.#asked = '';
  }

  async #ask(text: string): Promise<void> {
    this.#asked = text;
    this.loading.value = true;
    try {
      const items = await this.#api.suggest.call({ session: this.#session, text, limit: this.#settings.limit });
      this.items.value = [...items].sort((a, b) => b.score - a.score);
      this.loading.value = false;
    } catch (error) {
      if (isSuperseded(error)) { return; }
      this.#asked = '';
      this.items.value = [];
      this.loading.value = false;
    }
  }
}
