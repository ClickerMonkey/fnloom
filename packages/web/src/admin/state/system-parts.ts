/**
 * What one system added to the hub, for its admin page beside its fns: its context items (declared in its contract or
 * its `context/` folder, or added while running) and its named types (every instance's too), each the hub's own list
 * for the system, a page at a time. Nothing is kept beyond the open system's pages.
 */
import { ContextRecord, TypeRecord, type SystemName } from '@harness/core';
import { ref } from 'vue';
import { Paged } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import { typesQuery } from '../logic/instances.ts';
import { systemContextQuery } from '../logic/systems.ts';

type PartsApi = Pick<AdminApi, 'query'>;

/** How many context items or types are read per page. */
export const SYSTEM_PARTS_PAGE = 50;

/** One system's context and types. */
export class SystemPartsStore {
  readonly #api: PartsApi;
  /** Its context items, by key. */
  readonly context: Paged<ContextRecord, SystemName | undefined>;
  /** Its named types, by name. */
  readonly types: Paged<TypeRecord, SystemName | undefined>;
  /** How many of each the hub counted, once their first page is read. */
  readonly contextCount = ref<number | undefined>(undefined);
  readonly typeCount = ref<number | undefined>(undefined);

  constructor(api: PartsApi) {
    this.#api = api;
    this.context = new Paged<ContextRecord, SystemName | undefined>({
      fetch: async (system, cursor, limit) => {
        if (system === undefined) { return { items: [] }; }
        const page = await this.#api.query.call(systemContextQuery(system, cursor, limit));
        if (cursor === undefined) { this.contextCount.value = page.total; }
        return { items: ContextRecord.array().parse(page.items), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
      },
      key: (item) => item.name,
      failure: "Couldn't load this system's context.",
      limit: SYSTEM_PARTS_PAGE,
    }, undefined);
    this.types = new Paged<TypeRecord, SystemName | undefined>({
      fetch: async (system, cursor, limit) => {
        if (system === undefined) { return { items: [] }; }
        const page = await this.#api.query.call(typesQuery({ system }, cursor, limit));
        if (cursor === undefined) { this.typeCount.value = page.total; }
        return { items: TypeRecord.array().parse(page.items), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
      },
      key: (type) => type.name,
      failure: "Couldn't load this system's types.",
      limit: SYSTEM_PARTS_PAGE,
    }, undefined);
  }

  /** Read a system's context (again, quietly refreshed when it is the one shown). */
  async loadContext(system: SystemName): Promise<void> {
    if (this.context.filter.value === system && this.context.loaded.value) { await this.context.refresh(); return; }
    this.contextCount.value = undefined;
    await this.context.load(system);
  }

  /** Read a system's types (again, quietly refreshed when it is the one shown). */
  async loadTypes(system: SystemName): Promise<void> {
    if (this.types.filter.value === system && this.types.loaded.value) { await this.types.refresh(); return; }
    this.typeCount.value = undefined;
    await this.types.load(system);
  }

  /** Forget the open system's pages. */
  close(): void {
    void this.context.load(undefined);
    void this.types.load(undefined);
    this.contextCount.value = undefined;
    this.typeCount.value = undefined;
  }
}
