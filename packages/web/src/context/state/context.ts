/**
 * The context pages' state: the list of every context item the person may see (filtered, page by page, refreshed
 * quietly when an item changes), one item opened with its links both ways, and what a person does there: write a
 * memory, edit or forget one, draw a link, remove a link they drew, and make context from a resource. Each change
 * answers whether it worked and reloads what it touched; live `context` events reload the rest.
 */
import type { ContextFromResourceArgs, ContextFromResourceResult, ContextItemView, ContextLink, ContextRecord, QualifiedName } from '@harness/core';
import { getCurrentScope, onScopeDispose, ref } from 'vue';
import { Loaded, Paged, Task, type Outcome } from '../../state/loaded.ts';
import type { ContextApi, ContextEvents } from '../api/context.ts';
import { linkRequest, memoryRequest, memoryUpdate, type ContextFilter, type LinkDraft, type MemoryDraft } from '../logic/context.ts';

/** How many items a page of the list holds. */
export const CONTEXT_PAGE = 50;

type ItemApi = Pick<ContextApi, 'item' | 'list' | 'link' | 'unlink' | 'forget' | 'updateMemory'>;

/** What the context pages need. */
export interface ContextDeps {
  readonly api: Pick<ContextApi, 'list' | 'item' | 'link' | 'unlink' | 'forget' | 'remember' | 'updateMemory' | 'fromResource'>;
  readonly events: ContextEvents;
}

/** One opened context item. */
export class ContextItemStore {
  readonly #api: ItemApi;
  readonly name = ref<QualifiedName | undefined>(undefined);
  readonly view = new Loaded<ContextItemView>();
  /** The items its choices load, by name (for their titles and sizes); a choice whose item isn't here shows its words alone. */
  readonly choiceTargets = ref<ReadonlyMap<QualifiedName, ContextRecord>>(new Map());
  readonly linking = new Task();
  readonly unlinking = new Task();
  readonly forgetting = new Task();
  readonly saving = new Task();

  constructor(api: ItemApi) {
    this.#api = api;
  }

  /** Show an item (quietly when it is the one already shown). */
  async open(name: QualifiedName): Promise<void> {
    const same = this.name.value === name && this.view.value.value !== undefined;
    if (!same) { this.view.reset(); this.choiceTargets.value = new Map(); }
    this.name.value = name;
    await this.view.load(() => this.#api.item.call({ name }), "Couldn't load this context item.", same);
    await this.#loadChoiceTargets(name);
  }

  /** Read the items the open item's choices load, in one page. Their words still show when this fails. */
  async #loadChoiceTargets(name: QualifiedName): Promise<void> {
    const targets = [...new Set(this.view.value.value?.record.decl.choices?.map((choice) => choice.to) ?? [])];
    if (targets.length === 0) { this.choiceTargets.value = new Map(); return; }
    try {
      const page = await this.#api.list.call({ query: { filters: [{ field: 'name', op: 'in', values: targets }] }, limit: Math.min(targets.length, 200) });
      if (this.name.value === name) { this.choiceTargets.value = new Map(page.items.map((record) => [record.name, record])); }
    } catch { /* the choices keep their words; their titles and sizes are extras */ }
  }

  close(): void {
    this.name.value = undefined;
    this.view.reset();
    this.choiceTargets.value = new Map();
  }

  /** Whether a change to `name` shows on the open item: the item itself, or an item at either end of its links. */
  touches(name: QualifiedName): boolean {
    const view = this.view.value.value;
    if (this.name.value === undefined || view === undefined) { return false; }
    return this.name.value === name || view.backlinks.some((link) => link.from === name) || view.links.some((link) => link.to.kind === 'context' && link.to.name === name);
  }

  /** Load the open item again in the background. */
  async reload(): Promise<void> {
    const name = this.name.value;
    if (name !== undefined) { await this.open(name); }
  }

  /** Draw a link from the open item. */
  async addLink(draft: LinkDraft): Promise<Outcome<ContextLink>> {
    const from = this.name.value;
    if (from === undefined) { return { ok: false, problem: 'No context item is open.' }; }
    const request = linkRequest(draft, from);
    if (!request.ok) { this.linking.problem.value = request.problem; return request; }
    const result = await this.linking.run(() => this.#api.link.call({ from, to: request.value.to, relation: request.value.relation, weight: request.value.weight }), "Couldn't add that link.");
    if (result.ok) { await this.reload(); }
    return result;
  }

  /** Remove a link a person drew. */
  async removeLink(link: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): Promise<Outcome<boolean>> {
    const result = await this.unlinking.run(async () => (await this.#api.unlink.call({ from: link.from, toKey: link.toKey, relation: link.relation })).ok, "Couldn't remove that link.");
    if (result.ok) { await this.reload(); }
    return result;
  }

  /** Forget the open memory: it is turned off and left out of every selection and search. */
  async forget(): Promise<Outcome<boolean>> {
    const name = this.name.value;
    if (name === undefined) { return { ok: false, problem: 'No context item is open.' }; }
    const result = await this.forgetting.run(async () => (await this.#api.forget.call({ name })).ok, "Couldn't forget this memory.");
    if (result.ok) { await this.reload(); }
    return result;
  }

  /** Change the open memory in place (its words and options; its scope stays as written). Answers its name. */
  async edit(draft: MemoryDraft): Promise<Outcome<QualifiedName>> {
    const view = this.view.value.value;
    if (view?.record.origin?.type !== 'memory') { return { ok: false, problem: 'Only a memory can be edited.' }; }
    const request = memoryUpdate(view.record.name, draft);
    if (!request.ok) { this.saving.problem.value = request.problem; return request; }
    const result = await this.saving.run(async () => (await this.#api.updateMemory.call(request.value)).name, "Couldn't save this memory.");
    if (result.ok) { await this.open(result.value); }
    return result;
  }
}

/** The context pages. */
export class ContextStore {
  readonly #deps: ContextDeps;
  readonly list: Paged<ContextRecord, ContextFilter>;
  readonly item: ContextItemStore;
  readonly remembering = new Task();
  readonly making = new Task();
  #following = 0;
  #stop: (() => void) | undefined;

  constructor(deps: ContextDeps) {
    this.#deps = deps;
    this.list = new Paged<ContextRecord, ContextFilter>({
      fetch: (filter, cursor, limit) => deps.api.list.call({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) }),
      key: (record) => record.name,
      failure: "Couldn't load the context.",
      limit: CONTEXT_PAGE,
    }, {});
    this.item = new ContextItemStore(deps.api);
  }

  /** Show the list for a filter (again only when it changed, or when nothing is loaded yet). */
  async show(filter: ContextFilter): Promise<void> {
    if (this.list.loaded.value && JSON.stringify(filter) === JSON.stringify(this.list.filter.value)) { await this.list.refresh(); return; }
    await this.list.load(filter);
  }

  /**
   * Follow live context changes while a context page is shown: the list refreshes quietly, and the open item reloads
   * when the change touches it. Stops with the calling component's scope (or the function returned).
   */
  follow(): () => void {
    this.#following++;
    this.#stop ??= this.#deps.events((name) => { this.changed(name); });
    let stopped = false;
    const stop = (): void => {
      if (stopped) { return; }
      stopped = true;
      this.#following--;
      if (this.#following === 0) { this.#stop?.(); this.#stop = undefined; }
    };
    if (getCurrentScope() !== undefined) { onScopeDispose(stop); }
    return stop;
  }

  /** An item changed. */
  changed(name: QualifiedName): void {
    void this.list.refresh();
    if (this.item.touches(name)) { void this.item.reload(); }
  }

  /** Write a memory; answers its name. */
  async remember(draft: MemoryDraft): Promise<Outcome<QualifiedName>> {
    const request = memoryRequest(draft);
    if (!request.ok) { this.remembering.problem.value = request.problem; return request; }
    const result = await this.remembering.run(async () => (await this.#deps.api.remember.call(request.value)).name, "Couldn't remember that.");
    if (result.ok) { void this.list.refresh(); }
    return result;
  }

  /** Make context from a resource (or chosen sections of it). Making it again updates the same items. */
  async fromResource(args: ContextFromResourceArgs): Promise<Outcome<ContextFromResourceResult>> {
    const result = await this.making.run(() => this.#deps.api.fromResource.call(args), "Couldn't make context from that resource.");
    if (result.ok) { void this.list.refresh(); }
    return result;
  }
}
