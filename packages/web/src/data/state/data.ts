/**
 * The Data pages' state (build 8): the stored types the person sees (by words and system, a page at a time) (the saved
 * widgets are the widgets system's own page, `/s/widgets/saved`), the actions rows offer, an export, and one
 * stored type's records page with the record opened from it: its value, saving it (with the version it changes, so two
 * people editing at once don't overwrite each other), removing it and its history. Every read is the hub's query with
 * a page; nothing here holds a whole set.
 */
import {
  type DataRecord, type DataSetView, type ExportQuery, type Json, type QualifiedName, type RecordId, type RecordPage, type RecordQuery, type RecordTableQuery,
  type RecordVersion, type ResultTable, type RowActionsQuery, type SystemName, type WidgetActionOption,
} from '@harness/core';
import { ref, shallowRef } from 'vue';
import { Loaded, Paged, Task } from '../../state/loaded.ts';
import type { DataApi } from '../api.ts';

/** How many stored types a page holds. */
export const DATA_SETS_PAGE = 50;
/** How many versions of a record a page holds. */
export const RECORD_VERSIONS_PAGE = 20;

/** What the stored types list is narrowed by. */
export interface DataSetFilter {
  readonly text: string;
  readonly system: SystemName | undefined;
}

type StoreApi = Pick<DataApi, 'dataSets' | 'records' | 'rowActions' | 'readFn' | 'exportCsv' | 'recordTable' | 'record' | 'saveRecord' | 'removeRecord' | 'recordVersions'>;

/** The Data pages. */
export class DataStore {
  readonly #api: StoreApi;
  /** The stored types, a page at a time. */
  readonly sets: Paged<DataSetView, DataSetFilter>;

  constructor(api: StoreApi) {
    this.#api = api;
    this.sets = new Paged<DataSetView, DataSetFilter>({
      fetch: async (filter, cursor, limit) => this.#api.dataSets.call({
        limit, ...(cursor === undefined ? {} : { cursor }), ...(filter.text === '' ? {} : { text: filter.text }), ...(filter.system === undefined ? {} : { system: filter.system }),
      }),
      key: (set) => set.type,
      failure: "Couldn't load the stored data.",
      limit: DATA_SETS_PAGE,
    }, { text: '', system: undefined });
  }

  /** The actions rows of these types offer, narrowed by a widget's list when given. */
  async rowActions(query: RowActionsQuery): Promise<readonly WidgetActionOption[]> {
    return this.#api.rowActions.call(query);
  }

  /** A page of one stored type's records the person sees, searched, filtered and sorted by the hub (build 9: the Claude fleet). */
  async findRecords(query: RecordQuery): Promise<RecordPage> {
    return this.#api.records.call(query);
  }

  /** Run a read fn as the person outside any session and give its output; refused for a fn that is not a read. */
  async readFn(fn: QualifiedName, args: Readonly<Record<string, Json>>): Promise<Json> {
    return this.#api.readFn.call({ fn, args: { ...args } });
  }

  /** The bytes of a read fn's whole result as CSV, streamed by the hub as it runs it page by page. */
  async exportCsv(query: ExportQuery): Promise<Blob> {
    const stream = await this.#api.exportCsv.call(query);
    return new Response(stream).blob();
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
  /**
   * The query the table shown answers, once one has: until it is the query asked, the table is another query's (an
   * earlier search, filter or type), so it can't say this one has no records.
   */
  readonly shown = shallowRef<RecordTableQuery | undefined>(undefined);
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
    // another type's records are never shown as this one's while it loads
    if (this.#query !== undefined && this.#query.type !== query.type) { this.table.reset(); this.shown.value = undefined; }
    this.#query = query;
    await this.table.load(() => this.#api.recordTable.call(query), "Couldn't load these records.", quiet);
    if (this.#query === query && this.table.problem.value === '') { this.shown.value = query; }
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

  /** A window of records, as the widget view pages through them (the page's own query is left as it was). */
  async window(query: RecordTableQuery): Promise<ResultTable> {
    return this.#api.recordTable.call(query);
  }

  /** A record changed elsewhere (an inline edit's run): the record opened follows. */
  follow(saved: DataRecord): void {
    if (this.record.value.value?.id === saved.id) { this.record.set(saved); void this.#history(saved.type, saved.id, true); }
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
