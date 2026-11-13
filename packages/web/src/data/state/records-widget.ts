/**
 * The Data page's records as a widget (widget pass, data-grid "one view"): a `WidgetSource` over `hub/records_table`
 * that reads a window of the page's query from an offset, and the page's `WidgetHost`, which changes records in place
 * (the grid's inline edits) and exports them whole. The page runs no fns of its own: a row opens its record beside the
 * grid (the page's row menu), so the host offers no row actions and runs nothing.
 */
import type { Json, RecordTableQuery } from '@harness/core';
import { saveBlob } from '../../components/visuals/export.ts';
import type { WidgetFrame, WidgetSource } from '../../components/widgets/widget-source.ts';
import type { RunOutcome, WidgetHost } from '../../components/widgets/widgets.ts';
import { RECORDS_PAGING, recordsFrame } from '../logic/data.ts';
import type { DataStore, RecordsStore } from './data.ts';

/** A stored type's records under the page's query, a window at a time. */
export class RecordsWidgetSource implements WidgetSource {
  readonly #records: Pick<RecordsStore, 'window'>;
  readonly #query: RecordTableQuery;
  readonly #title: string;

  constructor(records: Pick<RecordsStore, 'window'>, query: RecordTableQuery, title: string) {
    this.#records = records;
    this.#query = query;
    this.#title = title;
  }

  async run(args: Readonly<Record<string, Json>>): Promise<WidgetFrame> {
    const at = args[RECORDS_PAGING.offset];
    const query = { ...this.#query, offset: typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : 0 };
    return recordsFrame(await this.#records.window(query), query, this.#title);
  }
}

/** What the records page's host uses. */
export interface RecordsHostDeps {
  readonly data: Pick<DataStore, 'exportCsv'>;
  readonly records: Pick<RecordsStore, 'update'>;
}

const NOTHING_RUNS = 'Records open beside the grid; run actions on them from a chat.';

/** The records page's widget host. */
export function recordsWidgetHost(deps: RecordsHostDeps): WidgetHost {
  return {
    actions: () => Promise.resolve([]),
    read: () => Promise.reject(new Error(NOTHING_RUNS)),
    quiet: true,
    run: (): Promise<RunOutcome> => Promise.resolve({ ok: false, problem: NOTHING_RUNS }),
    exportCsv: async (query, fileName) => { saveBlob(await deps.data.exportCsv(query), fileName); },
    update: (change) => deps.records.update(change),
  };
}
