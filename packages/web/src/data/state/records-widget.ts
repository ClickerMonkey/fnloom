/**
 * The Data page's records as a widget (widget pass, data-grid "one view": same visuals, controls, actions): a
 * `WidgetSource` over `hub/records_table` that reads a window of the page's query from an offset, and the page's
 * `WidgetHost`. Rows offer their type's actions (`hub/row_actions`), as they do in a chat or a widget, and every change
 * runs as the person's own run (an action, and each inline edit through `hub/record_update`), so the hub's approval
 * rules see it and its run records it. Those runs go to one chat made for the page the first time something runs
 * ("Data: Note"), where a run that asks first is approved.
 */
import { DataRecord, QualifiedName, type Json, type RecordTableQuery, type RecordUpdate } from '@harness/core';
import type { ChatStore } from '../../chat/state/chat.ts';
import type { ThreadStore } from '../../chat/state/thread.ts';
import { settledRun } from '../../chat/state/widget-host.ts';
import { saveBlob } from '../../components/visuals/export.ts';
import type { WidgetFrame, WidgetSource } from '../../components/widgets/widget-source.ts';
import type { RunOutcome, WidgetHost } from '../../components/widgets/widgets.ts';
import { RECORDS_PAGING, recordsFrame } from '../logic/data.ts';
import type { DataStore, RecordsStore } from './data.ts';

/** The fn an inline edit runs as (`hub/record_update`). */
export const RECORD_UPDATE_FN = QualifiedName.parse('hub/record_update');

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

/**
 * The runs a records page starts, in one chat made the first time something runs and listened to while the page is
 * open (a run that stops for approval is approved there).
 */
export class RecordsRuns {
  readonly #chat: Pick<ChatStore, 'sessions' | 'thread'>;
  readonly #title: () => string;
  #thread: Promise<ThreadStore | undefined> | undefined;
  #closed = false;

  constructor(chat: Pick<ChatStore, 'sessions' | 'thread'>, title: () => string) {
    this.#chat = chat;
    this.#title = title;
  }

  /** Run a fn as the person's run in the page's chat, resolving when it settles. */
  async run(fn: QualifiedName, args: Json, waiting?: () => void): Promise<RunOutcome> {
    const thread = await (this.#thread ??= this.#open());
    if (thread === undefined) {
      this.#thread = undefined;
      return { ok: false, problem: this.#chat.sessions.problem.value || "Couldn't start a chat to run it in." };
    }
    const id = await thread.invoke(fn, args);
    if (id === undefined) { return { ok: false, problem: thread.problem.value || "Couldn't run that." }; }
    return settledRun(thread, id, waiting);
  }

  /** Stop listening to the page's chat (the page left). */
  close(): void {
    this.#closed = true;
    void this.#thread?.then((thread) => { thread?.close(); });
  }

  async #open(): Promise<ThreadStore | undefined> {
    const session = await this.#chat.sessions.create({ title: this.#title() });
    if (session === undefined) { return undefined; }
    const thread = this.#chat.thread(session);
    if (!this.#closed) { await thread.open(); }
    return thread;
  }
}

/** What the records page's host uses. */
export interface RecordsHostDeps {
  readonly data: Pick<DataStore, 'exportCsv' | 'rowActions' | 'readFn'>;
  readonly records: Pick<RecordsStore, 'follow'>;
  readonly runs: Pick<RecordsRuns, 'run'>;
}

/** The records page's widget host. */
export function recordsWidgetHost(deps: RecordsHostDeps): WidgetHost {
  return {
    actions: (query) => deps.data.rowActions(query),
    read: (fn, args) => deps.data.readFn(fn, args),
    quiet: true,
    run: (fn, args, waiting) => deps.runs.run(fn, args, waiting),
    exportCsv: async (query, fileName) => { saveBlob(await deps.data.exportCsv(query), fileName); },
    update: async (change: RecordUpdate) => {
      const args = { type: change.type, id: change.id, set: change.set, ...(change.expect === undefined ? {} : { expect: change.expect }) };
      const outcome = await deps.runs.run(RECORD_UPDATE_FN, args);
      if (!outcome.ok) { throw new Error(outcome.problem); }
      const saved = DataRecord.safeParse(outcome.output);
      if (saved.success) { deps.records.follow(saved.data); }
    },
  };
}
