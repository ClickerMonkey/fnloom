/**
 * Suggestions while writing: once typing pauses on a draft long enough to mean something, the hub's index is asked
 * which fns and context match it by meaning, and the composer shows them as a faint row. A new keystroke cancels the
 * pending ask; sending clears the row.
 */
import type { SessionId, Suggestion } from '@harness/core';
import { ref, shallowRef } from 'vue';
import type { ChatApi } from '../api.ts';

/** When to ask: after this pause (ms), for drafts at least this long, for this many suggestions. */
export interface SuggestSettings {
  readonly pause: number;
  readonly minLength: number;
  readonly limit: number;
}

export const SUGGEST: SuggestSettings = { pause: 700, minLength: 12, limit: 6 };

/** Suggestions for the draft of one session. */
export class DraftSuggestions {
  readonly #api: Pick<ChatApi, 'suggest'>;
  readonly #session: SessionId;
  readonly #settings: SuggestSettings;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
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
    clearTimeout(this.#timer);
    const generation = ++this.#generation;
    const draft = text.trim();
    if (draft.length < this.#settings.minLength || draft.startsWith('/') || draft.startsWith('!')) {
      this.items.value = [];
      this.loading.value = false;
      this.#asked = '';
      return;
    }
    if (draft === this.#asked) { return; }
    this.#timer = setTimeout(() => { void this.#ask(draft, generation); }, this.#settings.pause);
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#generation++;
    this.items.value = [];
    this.loading.value = false;
    this.#asked = '';
  }

  async #ask(text: string, generation: number): Promise<void> {
    this.loading.value = true;
    try {
      const items = await this.#api.suggest.call({ session: this.#session, text, limit: this.#settings.limit });
      if (generation !== this.#generation) { return; }
      this.items.value = [...items].sort((a, b) => b.score - a.score);
      this.#asked = text;
    } catch {
      if (generation === this.#generation) { this.items.value = []; }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }
}
