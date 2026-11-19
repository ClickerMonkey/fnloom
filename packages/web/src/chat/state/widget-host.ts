/**
 * The widget host of a chat thread (widget pass): row actions, quiet reads and the streamed export from the data store;
 * actions run in the thread as the person's runs, each resolving when its run settles; drill levels kept in the URL's
 * `level`; and asking the agent (a request sent, or put in the composer to finish).
 *
 * Reads are quiet (the hub's `readFn`, outside the session): a widget's pager, range, drill and refresh reads stay out
 * of the thread, so live widgets re-run on their own.
 *
 * The same thread is the chat host system renderers get (the SDK's `CHAT_HOST`): asking the agent, and waiting for a
 * run they started to end.
 */
import { isSettled, type Json, type QualifiedName, type RunId } from '@harness/core';
import { watch, type WatchStopHandle } from 'vue';
import { saveBlob } from '../../components/visuals/export.ts';
import type { ChatHost } from '@harness/sdk';
import type { RunOutcome, WidgetHost } from '../../components/widgets/widgets.ts';
import type { DataStore } from '../../data/state/data.ts';
import { runEnding } from '../logic/runs.ts';
import type { ThreadStore } from './thread.ts';

/** What the chat's widget host uses. */
export interface ThreadWidgetDeps {
  readonly thread: Pick<ThreadStore, 'invoke' | 'runs' | 'ensureRun' | 'problem'>;
  readonly data: Pick<DataStore, 'rowActions' | 'readFn' | 'exportCsv'>;
  /** The URL's `level` value. */
  readonly levels: { get(): string; set(text: string): void };
  /** Send a request to the agent (`send`), or put it in the composer to finish. */
  ask(text: string, send: boolean): Promise<boolean>;
  /** After a run starts (the thread scrolls to it). */
  started?(): void;
}

/**
 * How long a waiter gives a settled run's record to bring its outcome (ms before each read): the thread reads it as
 * the status event lands, and these reads follow in case that one failed or came back before the hub stored it.
 */
export const OUTCOME_READS: readonly number[] = [0, 300, 1_000, 3_000];

/**
 * Wait for a run in the thread to end, and give how it ended (`runEnding`); `waiting` is called once if it stops for
 * approval. A run the hub says has settled ends only with its outcome (the result, or why it was declined, refused or
 * failed), which comes with its record after the status event: until then its record is read again (`OUTCOME_READS`),
 * and then what is known stands.
 */
export function settledRun(thread: Pick<ThreadStore, 'runs' | 'ensureRun'>, run: RunId, waiting?: () => void): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let ended = false;
    let told = false;
    let reading = false;
    const end = (outcome: RunOutcome): void => {
      if (ended) { return; }
      ended = true;
      resolve(outcome);
      queueMicrotask(() => { stop(); });
    };
    const readOutcome = async (): Promise<void> => {
      for (const delay of OUTCOME_READS) {
        await new Promise((wake) => { setTimeout(wake, delay); });
        if (ended) { return; }
        await thread.ensureRun(run, true);
      }
      // a run that started again meanwhile (a retry) is waited on afresh
      const view = thread.runs.value.get(run);
      const ending = view === undefined ? undefined : runEnding(view, true);
      if (ending !== undefined) { end(ending); } else { reading = false; }
    };
    const stop: WatchStopHandle = watch(() => thread.runs.value.get(run), (view) => {
      if (view === undefined || ended) { return; }
      if (!told && view.status === 'awaiting-approval') { told = true; waiting?.(); }
      const ending = runEnding(view);
      if (ending !== undefined) { end(ending); return; }
      if (isSettled(view.status) && !reading) { reading = true; void readOutcome(); }
    }, { immediate: true });
  });
}

/** A chat thread's host for system renderers: the thread's ask, and waiting on its runs (`settledRun`). */
export function threadChatHost(deps: Pick<ThreadWidgetDeps, 'thread' | 'ask'> & { navigate(path: string): void }): ChatHost {
  return {
    ask: (text, send) => deps.ask(text, send),
    settled: (run, waiting) => settledRun(deps.thread, run, waiting),
    navigate: (path) => { deps.navigate(path); },
  };
}

/** A chat thread's widget host. */
export function threadWidgetHost(deps: ThreadWidgetDeps): WidgetHost {
  const run = async (fn: QualifiedName, args: Json, waiting?: () => void): Promise<RunOutcome> => {
    const id = await deps.thread.invoke(fn, args);
    if (id === undefined) { return { ok: false, problem: deps.thread.problem.value || "Couldn't run that." }; }
    deps.started?.();
    return settledRun(deps.thread, id, waiting);
  };
  return {
    actions: (query) => deps.data.rowActions(query),
    read: (fn, args) => deps.data.readFn(fn, args),
    quiet: true,
    run,
    exportCsv: async (query, fileName) => { saveBlob(await deps.data.exportCsv(query), fileName); },
    levels: deps.levels,
    ask: (text, send) => deps.ask(text, send),
  };
}
