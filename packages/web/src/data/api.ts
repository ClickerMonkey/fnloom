/**
 * The data system's callers (build 8), made once from the one hub client: the stored types the person sees, a type's
 * records (as a list and as a result table), one record, saving, changing in place and removing one, its history, the actions rows of some
 * types offer (widgets and tables), a read fn's whole result as CSV (the hub's streamed export), and any item's version
 * history. Stores receive only the callers they use, so tests hand them fakes.
 */
import type { Hub } from '../api/client.ts';

/** The cache tag of everything a record change makes stale. */
export const RECORDS_TAG = 'records';

/** Make the data callers. */
export function dataApi(hub: Hub) {
  return {
    dataSets: hub.caller('dataSets', { cache: { ttl: 10_000, tags: [RECORDS_TAG] }, dedupe: true, lastOnly: true }),
    records: hub.caller('records', { dedupe: true, lastOnly: true }),
    /** A type's records as the result grid draws them; a newer query (search, sort, page) supersedes one on its way. */
    recordTable: hub.caller('recordTable', { lastOnly: true }),
    record: hub.caller('record', { dedupe: true }),
    saveRecord: hub.caller('saveRecord', { invalidates: [RECORDS_TAG] }),
    removeRecord: hub.caller('removeRecord', { invalidates: [RECORDS_TAG] }),
    /** Change some fields of one record in place (the Data grid's inline edit). */
    updateRecord: hub.caller('updateRecord', { invalidates: [RECORDS_TAG] }),
    recordVersions: hub.caller('recordVersions', { dedupe: true }),
    /** The actions rows of some types offer, narrowed by a widget's list. */
    rowActions: hub.caller('rowActions', { cache: { ttl: 30_000 }, dedupe: true }),
    /** Run a read fn as the person outside any session and give its output (a widget's quiet reads). */
    readFn: hub.caller('readFn'),
    /** A read fn's whole result as CSV, streamed (`GET /api/export`). */
    exportCsv: hub.caller('export'),
    /** One item's version history (a fn, type, context item or any other part a system adds). */
    itemVersions: hub.caller('itemVersions', { dedupe: true }),
  };
}

/** The data callers. */
export type DataApi = ReturnType<typeof dataApi>;
