/**
 * The data system (build 8, `core/data.ts`): records of stored types, kept and searched by the hub. Every surface
 * (the hub link for systems, the hub fns `hub/records_*` for agents, the web's Data page) asks one `DataService` as
 * someone (`DataAsker`), and every read is a query with a page: filters and sorts go to the database, text and meaning
 * to the hub's index. The implementation is `StoreDataService` (`data/service.ts`).
 */
import type {
  ActorId, DataRecord, DataSetPage, DataSetQuery, RecordGet, RecordPage, RecordQuery, RecordRemove, RecordSave, RecordTableQuery, RecordUpdate,
  RecordVersionsPage, RecordVersionsQuery, ResultTable, RunId, SystemName,
} from '@harness/core';
import type { AccessScope } from '../access/index.ts';

/** Who asks: a person (or a system's actor outside a run), what they may see, and the system and run writing for them. */
export interface DataAsker {
  readonly actor: ActorId;
  readonly access: AccessScope;
  /** The system that writes, when one does (its records say so). */
  readonly system?: SystemName | undefined;
  /** The run that writes, when one does. */
  readonly run?: RunId | undefined;
}

/** Stored types and their records. */
export interface DataService {
  /** The stored types the asker sees, with how many records they see of each. */
  sets(query: DataSetQuery, asker: DataAsker): Promise<DataSetPage>;
  /** A page of one type's records, filtered, sorted and searched. */
  find(query: RecordQuery, asker: DataAsker): Promise<RecordPage>;
  /** One record, or undefined when there is none the asker may see. */
  get(query: RecordGet, asker: DataAsker): Promise<DataRecord | undefined>;
  /**
   * The same records as a `ResultTable`, offset-paged (what widgets draw): the id column is the key, the scalar fields
   * are editable in place, and `records` names the type and the id column.
   */
  table(query: RecordTableQuery, asker: DataAsker): Promise<ResultTable>;
  /** Add or replace a record; refused when the value doesn't fit the type, or the record moved past `expect`. */
  save(input: RecordSave, asker: DataAsker): Promise<DataRecord>;
  /** Widget pass: change some fields of one record in place (the Data grid's inline edit); checked like a save. */
  update(input: RecordUpdate, asker: DataAsker): Promise<DataRecord>;
  /** Remove a record; its versions stay. */
  remove(input: RecordRemove, asker: DataAsker): Promise<boolean>;
  /** A record's history, newest first. */
  versions(query: RecordVersionsQuery, asker: DataAsker): Promise<RecordVersionsPage>;
}
