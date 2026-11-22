/**
 * The suggestions setting (admins; no model by default): who picks, the stored setting, saving a change, and a try-out
 * that shows what would be suggested for a message now, used and not, with reasons. And the search decisions: who
 * filters search hits, for fns and for context.
 */
import type { SearchDecision, SearchDecisionsView, SearchItemKind, SessionId, SuggestDecision, SuggestDecisionView, SuggestionRecord } from '@harness/core';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type SuggestionsApi = Pick<AdminApi, 'suggestDecision' | 'setSuggestDecision' | 'previewSuggestions' | 'searchDecisions' | 'setSearchDecision'>;

/** The suggestions setting and its try-out. */
export class SuggestionsStore {
  readonly #api: SuggestionsApi;
  readonly decision = new Loaded<SuggestDecisionView>();
  readonly saving = new Task();
  readonly preview = new Loaded<SuggestionRecord | undefined>();
  /** Who filters search hits, for fns and for context. */
  readonly search = new Loaded<SearchDecisionsView>();
  readonly searchSaving = new Task();

  constructor(api: SuggestionsApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await this.decision.load(() => this.#api.suggestDecision.call({}), "Couldn't load the suggestions setting.", quiet);
  }

  /** Save the setting; answers what was stored. */
  async save(value: SuggestDecision): Promise<Outcome<SuggestDecisionView>> {
    const result = await this.saving.run(() => this.#api.setSuggestDecision.call(value), "Couldn't save the suggestions setting.");
    if (result.ok) { this.decision.set(result.value); }
    return result;
  }

  async loadSearch(quiet = false): Promise<void> {
    await this.search.load(() => this.#api.searchDecisions.call({}), "Couldn't load the search settings.", quiet);
  }

  /** Save who filters one item kind's search hits; answers both settings as stored. */
  async saveSearch(item: SearchItemKind, value: SearchDecision): Promise<Outcome<SearchDecisionsView>> {
    const result = await this.searchSaving.run(() => this.#api.setSearchDecision.call({ item, value }), "Couldn't save the search setting.");
    if (result.ok) { this.search.set(result.value); }
    return result;
  }

  /** What would be suggested for `text` in `session` now. */
  async try(session: SessionId, text: string): Promise<void> {
    await this.preview.load(() => this.#api.previewSuggestions.call({ session, text }), "Couldn't try the suggestions.");
  }
}
