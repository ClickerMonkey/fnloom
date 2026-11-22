/**
 * Injected context for admins: what is injected into one agent (its Injected tab) or one item's injections in every
 * agent it reaches (the context page), from `injections`; and an admin's per-agent switch and order of one item, from
 * `setInjection`. A switch shows at once and is put back if the hub refuses; the hub's answer (the item as that agent
 * now gets it) replaces it, and the list is read again quietly, since a new order moves the others.
 */
import type { InjectionsPage, InjectionView, QualifiedName } from '@harness/core';
import { ref } from 'vue';
import { Loaded, Task } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type InjectedApi = Pick<AdminApi, 'injections' | 'setInjection'>;

/** What the list is of: one agent's items, or one item in every agent. */
export type InjectedOf = { readonly agent: QualifiedName } | { readonly context: QualifiedName };

/** The key of one view: its agent and item. */
export const viewKey = (view: Pick<InjectionView, 'agent' | 'context'>): string => `${view.agent} ${view.context}`;

/** One agent's injections, or one item's. */
export class InjectedStore {
  readonly #api: InjectedApi;
  readonly of = ref<InjectedOf | undefined>(undefined);
  readonly page = new Loaded<InjectionsPage>();
  /** Switching or reordering one; `busyKey` says which. */
  readonly saving = new Task();
  readonly busyKey = ref('');

  constructor(api: InjectedApi) {
    this.#api = api;
  }

  /** Show one agent's items (`agent`) or one item's (`context`). */
  async open(of: InjectedOf, quiet = false): Promise<void> {
    this.of.value = of;
    await this.page.load(() => this.#api.injections.call(of), "Couldn't load what is injected.", quiet);
  }

  /** Read the list again, quietly. */
  async refresh(): Promise<void> {
    const of = this.of.value;
    if (of !== undefined) { await this.open(of, true); }
  }

  /** Switch one item on or off for its agent; whether it worked. */
  switchOn(view: InjectionView, on: boolean): Promise<boolean> {
    return this.#set(view, { on }, { ...view, on });
  }

  /** Give one item another order for its agent (`null`: its own order again); whether it worked. */
  reorder(view: InjectionView, order: number | null): Promise<boolean> {
    return this.#set(view, { order }, order === null ? view : { ...view, order });
  }

  async #set(view: InjectionView, change: { on?: boolean; order?: number | null }, shown: InjectionView): Promise<boolean> {
    const before = this.page.value.value;
    if (before !== undefined) { this.page.set(replaced(before, shown)); }
    this.busyKey.value = viewKey(view);
    const result = await this.saving.run(() => this.#api.setInjection.call({ agent: view.agent, context: view.context, ...change }), "Couldn't change that.");
    this.busyKey.value = '';
    if (!result.ok) {
      if (before !== undefined) { this.page.set(before); }
      return false;
    }
    const now = this.page.value.value;
    if (now !== undefined) { this.page.set(replaced(now, result.value)); }
    await this.refresh();
    return true;
  }

  close(): void {
    this.of.value = undefined;
    this.page.reset();
  }
}

/** A page with one view replaced by its agent and item. */
function replaced(page: InjectionsPage, view: InjectionView): InjectionsPage {
  return { ...page, injections: page.injections.map((item) => (viewKey(item) === viewKey(view) ? view : item)) };
}
