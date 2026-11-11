/**
 * One fn as its view shows it, for anyone who may see it: what it is (its search hit: description, kind, mode and
 * signature), its facts (types read and written, what it uses, cost and run times) and its examples, a page at a time.
 * The chat's fn modal and the fn page show the same store. A settled run of the fn (the user channel's `fn` event)
 * reads its facts again quietly, so the run times follow.
 */
import { type FnExampleView, type FnFacts, type FnSearchHit, type QualifiedName, type UserEvent } from '@harness/core';
import { ref, shallowRef } from 'vue';
import type { UserEvents } from '../../api/notifications.ts';
import { Loaded } from '../../state/loaded.ts';
import { problemText } from '../../state/problems.ts';
import type { FnsApi } from '../api.ts';

/** How many examples a page holds. */
export const EXAMPLES_PAGE = 5;

/** One fn's view. */
export class FnInfoStore {
  readonly #api: Pick<FnsApi, 'searchFns' | 'fnFacts' | 'fnExamples'>;
  readonly #events: UserEvents;
  #stop: (() => void) | undefined;
  readonly name = ref<QualifiedName | undefined>(undefined);
  /** The fn as search finds it; undefined when the person may not see it. */
  readonly about = new Loaded<FnSearchHit | undefined>();
  readonly facts = new Loaded<FnFacts>();
  /** Its examples loaded so far, and how many it has. */
  readonly examples = shallowRef<readonly FnExampleView[]>([]);
  readonly examplesTotal = ref(0);
  /** The offset of the next page; undefined once every example is loaded. */
  readonly examplesNext = ref<number | undefined>(undefined);
  readonly examplesLoading = ref(false);
  readonly examplesProblem = ref('');
  #examplesGeneration = 0;

  constructor(api: Pick<FnsApi, 'searchFns' | 'fnFacts' | 'fnExamples'>, events: UserEvents) {
    this.#api = api;
    this.#events = events;
  }

  /** Show a fn and follow its runs; the same fn again only refreshes, quietly. */
  async open(fn: QualifiedName): Promise<void> {
    const same = this.name.value === fn;
    if (!same) { this.close(); }
    this.name.value = fn;
    this.#stop ??= this.#events((event) => { this.#onEvent(event); });
    await Promise.all([this.#loadAbout(fn, same), this.#loadFacts(fn, same), same ? Promise.resolve() : this.moreExamples()]);
  }

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.name.value = undefined;
    this.about.reset();
    this.facts.reset();
    this.#examplesGeneration++;
    this.examples.value = [];
    this.examplesTotal.value = 0;
    this.examplesNext.value = undefined;
    this.examplesLoading.value = false;
    this.examplesProblem.value = '';
  }

  /** Load the next page of examples (the first, when none are loaded). */
  async moreExamples(): Promise<void> {
    const fn = this.name.value;
    const offset = this.examples.value.length === 0 ? 0 : this.examplesNext.value;
    if (fn === undefined || offset === undefined || this.examplesLoading.value) { return; }
    const generation = ++this.#examplesGeneration;
    this.examplesLoading.value = true;
    this.examplesProblem.value = '';
    try {
      const page = await this.#api.fnExamples.call({ fn, offset, limit: EXAMPLES_PAGE });
      if (generation !== this.#examplesGeneration) { return; }
      this.examples.value = [...this.examples.value, ...page.items];
      this.examplesTotal.value = page.total;
      this.examplesNext.value = page.next;
    } catch (error) {
      if (generation === this.#examplesGeneration) { this.examplesProblem.value = problemText(error, "Couldn't load its examples."); }
    } finally {
      if (generation === this.#examplesGeneration) { this.examplesLoading.value = false; }
    }
  }

  async #loadAbout(fn: QualifiedName, quiet: boolean): Promise<void> {
    await this.about.load(async () => {
      const page = await this.#api.searchFns.call({ names: [fn], items: ['fn'], available: false, limit: 1 });
      return page.items.find((hit) => hit.name === fn);
    }, "Couldn't load this fn.", quiet);
  }

  async #loadFacts(fn: QualifiedName, quiet: boolean): Promise<void> {
    await this.facts.load(() => this.#api.fnFacts.call({ fn }), "Couldn't load this fn's facts.", quiet);
  }

  #onEvent(event: UserEvent): void {
    const fn = this.name.value;
    if (event.type === 'fn' && fn !== undefined && event.fn === fn) { void this.#loadFacts(fn, true); }
  }
}
