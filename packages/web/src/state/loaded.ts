/**
 * The three shapes of remote state every store is made of, written once:
 * - `Loaded<T>`: one thing fetched, with its loading and problem state; a newer load wins over an older one.
 * - `Task`: something done (a save, an approval), with busy and problem state, answering whether it worked.
 * - `Paged<T, F>`: a list fetched page by page for a filter, newest first; changing the filter starts again.
 * Failures become one plain sentence (`problemText`).
 */
import { computed, ref, shallowRef, type ShallowRef } from 'vue';
import type { Outcome } from '../ui/types.ts';
import { problemText } from './problems.ts';

/** A loaded thing, with its loading and problem state. */
export class Loaded<T> {
  readonly value = shallowRef<T | undefined>(undefined);
  readonly loading = ref(false);
  readonly problem = ref('');
  #generation = 0;

  /** Fetch it. `quiet` keeps the loading state off (a refresh in the background). */
  async load(fetch: () => Promise<T>, failure: string, quiet = false): Promise<void> {
    const generation = ++this.#generation;
    if (!quiet) { this.loading.value = true; }
    this.problem.value = '';
    try {
      const value = await fetch();
      if (generation === this.#generation) { this.value.value = value; }
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, failure); }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }

  /** Change the value in place (a live update, or the answer of a save). */
  set(value: T): void {
    this.value.value = value;
  }

  reset(): void {
    this.#generation++;
    this.value.value = undefined;
    this.loading.value = false;
    this.problem.value = '';
  }
}

/** What doing a task came to. */
export type { Outcome } from '../ui/types.ts';

/** Something done, with busy and problem state. */
export class Task {
  readonly #running = ref(0);
  /** Whether it is running now. */
  readonly busy = computed(() => this.#running.value > 0);
  /** Why the last run failed; '' when it worked. */
  readonly problem = ref('');

  async run<R>(work: () => Promise<R>, failure: string): Promise<Outcome<R>> {
    this.#running.value++;
    this.problem.value = '';
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const problem = problemText(error, failure);
      this.problem.value = problem;
      return { ok: false, problem };
    } finally {
      this.#running.value--;
    }
  }
}

/** One page of a list. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string | undefined;
}

/** How a paged list fetches. */
export interface PagedSource<T, F> {
  fetch(filter: F, cursor: string | undefined, limit: number): Promise<Page<T>>;
  /** Tells items apart, so a page that overlaps the last adds nothing twice. */
  key(item: T): string;
  /** The sentence shown when a page can't be fetched. */
  readonly failure: string;
  /** How many to fetch per page. */
  readonly limit: number;
}

/** A list fetched page by page for a filter. */
export class Paged<T, F> {
  readonly #source: PagedSource<T, F>;
  #cursor: string | undefined;
  #generation = 0;
  readonly items = shallowRef<readonly T[]>([]);
  readonly filter: ShallowRef<F>;
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  /** Whether the first page for the current filter has arrived. */
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly #hasMore = ref(false);
  /** Whether there is another page to fetch. */
  readonly hasMore = computed(() => this.#hasMore.value);

  constructor(source: PagedSource<T, F>, filter: F) {
    this.#source = source;
    this.filter = shallowRef(filter);
  }

  /** Fetch the first page for `filter` (the current one when left out). */
  async load(filter: F = this.filter.value): Promise<void> {
    const generation = ++this.#generation;
    this.filter.value = filter;
    this.loading.value = true;
    this.problem.value = '';
    try {
      const page = await this.#source.fetch(filter, undefined, this.#source.limit);
      if (generation !== this.#generation) { return; }
      this.items.value = page.items;
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, this.#source.failure); }
    } finally {
      if (generation === this.#generation) { this.loading.value = false; }
    }
  }

  /**
   * Fetch the first page again without the loading state: new items go on top, items already shown are replaced by
   * their fresh copy, and pages fetched further down stay. Keeps a list alive without a jump.
   */
  async refresh(): Promise<void> {
    if (!this.loaded.value || this.loading.value) { return; }
    const generation = this.#generation;
    try {
      const page = await this.#source.fetch(this.filter.value, undefined, this.#source.limit);
      if (generation !== this.#generation) { return; }
      const fresh = new Map(page.items.map((item) => [this.#source.key(item), item]));
      const shown = new Set(this.items.value.map((item) => this.#source.key(item)));
      const added = page.items.filter((item) => !shown.has(this.#source.key(item)));
      this.items.value = [...added, ...this.items.value.map((item) => fresh.get(this.#source.key(item)) ?? item)];
      if (this.items.value.length === page.items.length) {
        this.#cursor = page.cursor;
        this.#hasMore.value = page.cursor !== undefined;
      }
    } catch {
      // a background refresh keeps what is shown; the next load reports problems
    }
  }

  /** Fetch the next page. */
  async more(): Promise<void> {
    const cursor = this.#cursor;
    if (cursor === undefined || this.loadingMore.value || this.loading.value) { return; }
    const generation = this.#generation;
    this.loadingMore.value = true;
    try {
      const page = await this.#source.fetch(this.filter.value, cursor, this.#source.limit);
      if (generation !== this.#generation) { return; }
      const known = new Set(this.items.value.map((item) => this.#source.key(item)));
      this.items.value = [...this.items.value, ...page.items.filter((item) => !known.has(this.#source.key(item)))];
      this.#cursor = page.cursor;
      this.#hasMore.value = page.cursor !== undefined;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, this.#source.failure); }
    } finally {
      this.loadingMore.value = false;
    }
  }
}
