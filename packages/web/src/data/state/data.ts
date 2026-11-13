/**
 * The Data pages' state (build 8): the stored types the person sees (by words and system, a page at a time), the saved
 * widgets (fns of the hub's widget kind, found by the hub's fn search), the actions widgets offer on rows, and one
 * stored type's records page with the record opened from it: its value, saving it (with the version it changes, so two
 * people editing at once don't overwrite each other), removing it and its history. Every read is the hub's query with
 * a page; nothing here holds a whole set.
 */
import {
  WIDGET_KIND, type DataRecord, type DataSetView, type FnSearchHit, type Json, type QualifiedName, type RecordId, type RecordTableQuery,
  type RecordVersion, type ResultTable, type SystemName, type WidgetActionOption,
} from '@harness/core';
import { ref, shallowRef } from 'vue';
import { Loaded, Paged, Task } from '../../state/loaded.ts';
import type { FnsApi } from '../../fns/api.ts';
import type { DataApi } from '../api.ts';

/** How many stored types or widgets a page holds. */
export const DATA_SETS_PAGE = 50;
/** How many versions of a record a page holds. */
export const RECORD_VERSIONS_PAGE = 20;

/** What the stored types list is narrowed by. */
export interface DataSetFilter {
  readonly text: string;
  readonly system: SystemName | undefined;
}

type StoreApi = Pick<DataApi, 'dataSets' | 'widgetActions' | 'recordTable' | 'record' | 'saveRecord' | 'removeRecord' | 'recordVersions'>;

/** The Data pages. */
export class DataStore {
  readonly #api: StoreApi;
  readonly #fns: Pick<FnsApi, 'searchFns'>;
  /** The stored types, a page at a time. */
  readonly sets: Paged<DataSetView, DataSetFilter>;
  /** The saved widgets, a page at a time, by words. */
  readonly widgets: Paged<FnSearchHit, string>;

  constructor(api: StoreApi, fns: Pick<FnsApi, 'searchFns'>) {
    this.#api = api;
    this.#fns = fns;
    this.sets = new Paged<DataSetView, DataSetFilter>({
      fetch: async (filter, cursor, limit) => this.#api.dataSets.call({
        limit, ...(cursor === undefined ? {} : { cursor }), ...(filter.text === '' ? {} : { text: filter.text }), ...(filter.system === undefined ? {} : { system: filter.system }),
      }),
      key: (set) => set.type,
      failure: "Couldn't load the stored data.",
      limit: DATA_SETS_PAGE,
    }, { text: '', system: undefined });
    this.widgets = new Paged<FnSearchHit, string>({
      fetch: async (text, cursor, limit) => {
        const offset = cursor === undefined ? 0 : Number(cursor);
        const page = await this.#fns.searchFns.call({ kinds: [WIDGET_KIND], items: ['fn'], limit, offset, ...(text === '' ? {} : { text }) });
        return { items: page.items, ...(page.next === undefined ? {} : { cursor: String(page.next) }) };
      },
      key: (hit) => hit.name,
      failure: "Couldn't load the saved widgets.",
      limit: DATA_SETS_PAGE,
    }, '');
  }

  /** The actions rows of these types offer, narrowed by a widget when given. */
  async widgetActions(types: readonly QualifiedName[], widget: QualifiedName | undefined): Promise<readonly WidgetActionOption[]> {
    return this.#api.widgetActions.call({ types: [...types], ...(widget === undefined ? {} : { widget }) });
  }

  /** A new records page (one stored type, with the record opened from it). */
  records(): RecordsStore {
    return new RecordsStore(this.#api);
  }
}

/** One stored type's records page and the record opened from it. */
export class RecordsStore {
  readonly #api: StoreApi;
  /** The page of records, as a result table. */
  readonly table = new Loaded<ResultTable>();
  #query: RecordTableQuery | undefined;
  /** The record opened, undefined when the hub has none by that id (or the person may not see it). */
  readonly record = new Loaded<DataRecord | undefined>();
  /** Its versions loaded so far, newest first, and where the next page starts. */
  readonly versions = shallowRef<readonly RecordVersion[]>([]);
  readonly versionsNext = ref<string | undefined>(undefined);
  readonly versionsLoading = ref(false);
  readonly versionsProblem = ref('');
  /** Saving or removing a record. */
  readonly saving = new Task();

  constructor(api: StoreApi) {
    this.#api = api;
  }

  /** Show a page of records; the same query again refreshes quietly. */
  async show(query: RecordTableQuery): Promise<void> {
    const quiet = this.#query !== undefined && JSON.stringify(this.#query) === JSON.stringify(query) && this.table.value.value !== undefined;
    this.#query = query;
    await this.table.load(() => this.#api.recordTable.call(query), "Couldn't load these records.", quiet);
  }

  /** Open one record and its first page of history. */
  async open(type: QualifiedName, id: RecordId): Promise<void> {
    const same = this.record.value.value?.id === id;
    await Promise.all([
      this.record.load(async () => (await this.#api.record.call({ type, id })).record, "Couldn't load this record.", same),
      this.#history(type, id, true),
    ]);
  }

  close(): void {
    this.record.reset();
    this.versions.value = [];
    this.versionsNext.value = undefined;
    this.versionsProblem.value = '';
  }

  /** More of the opened record's history. */
  async moreVersions(): Promise<void> {
    const record = this.record.value.value;
    if (record !== undefined && this.versionsNext.value !== undefined) { await this.#history(record.type, record.id, false); }
  }

  /** Save a record (a new one without `id`); the record and the page follow. Whether it was saved. */
  async save(type: QualifiedName, value: Json, id?: DataRecord['id'], expect?: number): Promise<DataRecord | undefined> {
    const outcome = await this.saving.run(() => this.#api.saveRecord.call({ type, value, ...(id === undefined ? {} : { id }), ...(expect === undefined ? {} : { expect }) }), "Couldn't save this record.");
    if (!outcome.ok) { return undefined; }
    if (this.record.value.value?.id === outcome.value.id) { this.record.set(outcome.value); void this.#history(type, outcome.value.id, true); }
    await this.#refresh();
    return outcome.value;
  }

  /** Remove a record; its history stays. Whether it was removed. */
  async remove(type: QualifiedName, id: DataRecord['id']): Promise<boolean> {
    const outcome = await this.saving.run(() => this.#api.removeRecord.call({ type, id }), "Couldn't remove this record.");
    if (!outcome.ok || !outcome.value.removed) { return false; }
    this.close();
    await this.#refresh();
    return true;
  }

  async #refresh(): Promise<void> {
    const query = this.#query;
    if (query !== undefined) { await this.table.load(() => this.#api.recordTable.call(query), "Couldn't load these records.", true); }
  }

  async #history(type: QualifiedName, id: RecordId, first: boolean): Promise<void> {
    this.versionsLoading.value = true;
    this.versionsProblem.value = '';
    try {
      const cursor = first ? undefined : this.versionsNext.value;
      const page = await this.#api.recordVersions.call({ type, id, limit: RECORD_VERSIONS_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      this.versions.value = first ? page.items : [...this.versions.value, ...page.items];
      this.versionsNext.value = page.cursor;
    } catch {
      this.versionsProblem.value = "Couldn't load this record's history.";
    } finally {
      this.versionsLoading.value = false;
    }
  }
}
