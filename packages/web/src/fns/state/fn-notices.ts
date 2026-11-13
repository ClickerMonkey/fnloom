/**
 * Each fn's notice ("This usually takes about 3 minutes."), from its facts, for the cards that show a run before it
 * ends: the approval card and a running run's card. A fn's facts are asked for once, the first time a card shows it;
 * a fn without a notice, or whose facts can't be read, shows none.
 */
import type { QualifiedName } from '@harness/core';
import { shallowRef } from 'vue';
import type { FnsApi } from '../api.ts';
import { useStoresIfAny } from '../../state/stores.ts';

/** The fns' notices, filled as cards ask. */
export class FnNotices {
  readonly #api: Pick<FnsApi, 'fnFacts'>;
  /** The fns whose facts were asked for (not reactive: asking happens while a card draws). */
  readonly #asked = new Set<QualifiedName>();
  /** The notices found so far. */
  readonly #notices = shallowRef<ReadonlyMap<QualifiedName, string>>(new Map());

  constructor(api: Pick<FnsApi, 'fnFacts'>) {
    this.#api = api;
  }

  /** The fn's notice, or '' when it has none; the first ask fetches its facts and fills it in when they come. */
  of(fn: QualifiedName): string {
    const known = this.#notices.value.get(fn);
    if (!this.#asked.has(fn)) {
      this.#asked.add(fn);
      void this.#load(fn);
    }
    return known ?? '';
  }

  async #load(fn: QualifiedName): Promise<void> {
    try {
      const facts = await this.#api.fnFacts.call({ fn });
      if (facts.notice !== undefined) { this.#notices.value = new Map([...this.#notices.value, [fn, facts.notice]]); }
    } catch {
      // no notice: the card shows the run without one
    }
  }
}

/** A card host's way to the notices: the app's, or none (a component mounted alone). */
export function useFnNotice(): (fn: QualifiedName) => string {
  const notices = useStoresIfAny()?.fnNotices;
  return (fn) => notices?.of(fn) ?? '';
}
