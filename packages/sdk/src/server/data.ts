/**
 * `ctx.data`: the data system over the hub link (`records`, `record`, `recordTable`, `saveRecord`, `removeRecord`).
 * Values cross the wire as JSON and are checked against the stored type both ways: encoded before a save, decoded
 * from every record read. The hub does the finding, filtering, sorting and paging in its database; nothing is loaded
 * whole here.
 */
import type { ActorId, DataRecord, RecordId, ResultTable, RunId } from '@harness/core';
import type { Data, RecordFind, StoredRecord, StoredType } from '../ctx.ts';
import type { HubAccess } from './link.ts';
import { decodeOrThrow, encodeOrThrow } from './wire.ts';

/** `Data` over the link, as the run's person (`run`) or as the system outside a run. */
export class HubData implements Data {
  readonly #hub: HubAccess;
  readonly #run: RunId | undefined;
  readonly #signal: AbortSignal | undefined;

  constructor(hub: HubAccess, scope: { run?: RunId | undefined; signal?: AbortSignal | undefined }) {
    this.#hub = hub;
    this.#run = scope.run;
    this.#signal = scope.signal;
  }

  async find<T>(type: StoredType<T>, find: RecordFind = {}): Promise<{ readonly items: StoredRecord<T>[]; readonly cursor?: string }> {
    const hub = await this.#ready();
    const page = await hub.call('records', { type: type.name, ...findBody(find), ...this.#scope() }, this.#options());
    return { items: page.items.map((record) => decoded(type, record)), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
  }

  async get<T>(type: StoredType<T>, id: RecordId): Promise<StoredRecord<T> | undefined> {
    const hub = await this.#ready();
    const { record } = await hub.call('record', { type: type.name, id, ...this.#scope() }, this.#options());
    return record === undefined ? undefined : decoded(type, record);
  }

  async table<T>(type: StoredType<T>, find: Parameters<Data['table']>[1] = {}): Promise<ResultTable> {
    const hub = await this.#ready();
    return hub.call('recordTable', {
      type: type.name,
      ...findBody(find),
      ...(find.offset === undefined ? {} : { offset: find.offset }),
      ...(find.limit === undefined ? {} : { limit: find.limit }),
      ...this.#scope(),
    }, this.#options());
  }

  async save<T>(type: StoredType<T>, value: T, options: { readonly id?: RecordId; readonly expect?: number; readonly owner?: ActorId } = {}): Promise<StoredRecord<T>> {
    const hub = await this.#ready();
    const saved = await hub.call('saveRecord', {
      type: type.name,
      value: encodeOrThrow(type, value, `The ${type.name} record`),
      ...(options.id === undefined ? {} : { id: options.id }),
      ...(options.expect === undefined ? {} : { expect: options.expect }),
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      ...this.#scope(),
    }, this.#options());
    return decoded(type, saved);
  }

  async remove(type: StoredType<unknown>, id: RecordId): Promise<boolean> {
    const hub = await this.#ready();
    const { removed } = await hub.call('removeRecord', { type: type.name, id, ...this.#scope() }, this.#options());
    return removed;
  }

  #ready() {
    return this.#hub.ready(this.#signal);
  }

  #scope(): { run?: RunId } {
    return this.#run === undefined ? {} : { run: this.#run };
  }

  #options(): { signal?: AbortSignal } {
    return this.#signal === undefined ? {} : { signal: this.#signal };
  }
}

/** The query and search of a find, as the link body takes them (absent parts left out). */
function findBody<Q>(find: { readonly query?: Q; readonly search?: string }): { query?: Q; search?: string } {
  return {
    ...(find.query === undefined ? {} : { query: find.query }),
    ...(find.search === undefined || find.search === '' ? {} : { search: find.search }),
  };
}

/** A record with its value checked against the stored type. */
function decoded<T>(type: StoredType<T>, record: DataRecord): StoredRecord<T> {
  return { ...record, value: decodeOrThrow(type, record.value, `A ${type.name} record`) };
}
