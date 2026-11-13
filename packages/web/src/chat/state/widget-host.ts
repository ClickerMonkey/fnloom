/**
 * The widget host of a chat thread (widget pass): row actions and the streamed export from the data store; reads and
 * actions run in the thread as the person's runs, each resolving when its run settles; drill levels kept in the
 * URL's `level`; and asking the agent (a request sent, or put in the composer to finish).
 *
 * Reads here are not quiet: the web API has no way to read a fn outside a session yet, so a widget's pager, range,
 * drill and refresh reads are runs in the thread, and live widgets don't re-run on their own.
 */
import { isSettled, type Json, type QualifiedName, type RunId } from '@harness/core';
import { watch, type WatchStopHandle } from 'vue';
import { saveBlob } from '../../components/visuals/export.ts';
import type { RunOutcome, WidgetHost } from '../../components/widgets/widgets.ts';
import type { DataStore } from '../../data/state/data.ts';
import { runError, runResult } from '../logic/runs.ts';
import type { ThreadStore } from './thread.ts';

/** What the chat's widget host uses. */
export interface ThreadWidgetDeps {
  readonly thread: Pick<ThreadStore, 'invoke' | 'runs' | 'problem'>;
  readonly data: Pick<DataStore, 'rowActions' | 'exportCsv'>;
  /** The URL's `level` value. */
  readonly levels: { get(): string; set(text: string): void };
  /** Send a request to the agent (`send`), or put it in the composer to finish. */
  ask(text: string, send: boolean): Promise<boolean>;
  /** After a run starts (the thread scrolls to it). */
  started?(): void;
}

/** Wait for a run in the thread to settle, and give how it ended. */
export function settledRun(thread: Pick<ThreadStore, 'runs'>, run: RunId): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const stop: WatchStopHandle = watch(() => thread.runs.value.get(run), (view) => {
      if (done || view === undefined || !isSettled(view.status)) { return; }
      done = true;
      const output = runResult(view);
      resolve(output !== undefined ? { ok: true, output } : { ok: false, problem: runError(view)?.message ?? `It ended ${view.status}.` });
      queueMicrotask(() => { stop(); });
    }, { immediate: true });
  });
}

/** A chat thread's widget host. */
export function threadWidgetHost(deps: ThreadWidgetDeps): WidgetHost {
  const run = async (fn: QualifiedName, args: Json): Promise<RunOutcome> => {
    const id = await deps.thread.invoke(fn, args);
    if (id === undefined) { return { ok: false, problem: deps.thread.problem.value || "Couldn't run that." }; }
    deps.started?.();
    return settledRun(deps.thread, id);
  };
  return {
    actions: (query) => deps.data.rowActions(query),
    read: async (fn, args) => {
      const ran = await run(fn, args);
      if (!ran.ok) { throw new Error(ran.problem); }
      return ran.output;
    },
    quiet: false,
    run,
    exportCsv: async (query, fileName) => { saveBlob(await deps.data.exportCsv(query), fileName); },
    levels: deps.levels,
    ask: (text, send) => deps.ask(text, send),
  };
}
