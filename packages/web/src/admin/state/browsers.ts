/**
 * The browsers: runs, LLM calls and resources. Each is a list paged for a filter (taken from the URL by its page)
 * and the one item opened beside it, fetched whole. One class, three sources.
 */
import type { LlmInteraction, LlmInteractionId, ResourceRead, ResourceRecord, ResourceUri, Run, RunId, TurnId, UndoReport } from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded, Paged, Task, type PagedSource, type TaskResult } from '../../state/loaded.ts';
import type { ChatApi } from '../../chat/api.ts';
import type { AdminApi } from '../api.ts';
import type { LlmFilter, LlmSummary, ResourceFilter, RunFilter } from '../contract.ts';

/** How many rows a browser fetches per page. */
export const BROWSER_PAGE = 50;

/** Where a browser's list and its opened item come from. */
export interface BrowserSource<T, F, Id, D> extends PagedSource<T, F> {
  one(id: Id): Promise<D>;
  /** The sentence shown when the opened item can't be fetched. */
  readonly oneFailure: string;
}

/** A list and the item opened beside it. */
export class Browser<T, F, Id, D> {
  readonly #source: BrowserSource<T, F, Id, D>;
  readonly list: Paged<T, F>;
  readonly opened = new Loaded<D>();
  readonly openedId = shallowRef<Id | undefined>(undefined);

  constructor(source: BrowserSource<T, F, Id, D>, filter: F) {
    this.#source = source;
    this.list = new Paged(source, filter);
  }

  /** Open an item; asking again for the open one refreshes it quietly. */
  async open(id: Id): Promise<void> {
    const same = this.openedId.value === id;
    if (!same) { this.opened.reset(); }
    this.openedId.value = id;
    await this.opened.load(() => this.#source.one(id), this.#source.oneFailure, same);
  }

  close(): void {
    this.openedId.value = undefined;
    this.opened.reset();
  }
}

/** The runs browser, which can also move a run to the background and undo a run's turn. */
export class RunsBrowser extends Browser<Run, RunFilter, RunId, Run> {
  readonly #chat: Pick<ChatApi, 'background' | 'undoTurn'>;
  readonly control = new Task();

  constructor(source: BrowserSource<Run, RunFilter, RunId, Run>, chat: Pick<ChatApi, 'background' | 'undoTurn'>) {
    super(source, {});
    this.#chat = chat;
  }

  /** Stop the agent waiting for a run; the run carries on. */
  async background(run: RunId): Promise<TaskResult<{ accepted: boolean }>> {
    const result = await this.control.run(() => this.#chat.background.call({ run }), "Couldn't move it to the background.");
    if (result.ok) { void this.open(run); }
    return result;
  }

  /** Undo everything a turn did that can be undone. */
  async undoTurn(turn: TurnId): Promise<TaskResult<UndoReport>> {
    const result = await this.control.run(() => this.#chat.undoTurn.call({ turn }), "Couldn't undo the turn.");
    if (result.ok) { void this.list.refresh(); }
    return result;
  }
}

export type LlmBrowser = Browser<LlmSummary, LlmFilter, LlmInteractionId, LlmInteraction>;
export type ResourcesBrowser = Browser<ResourceRecord, ResourceFilter, ResourceUri, ResourceRead>;

/** Runs, newest first; a run opens with its full record. */
export function runsBrowser(api: Pick<AdminApi, 'runs'>, chat: Pick<ChatApi, 'run' | 'background' | 'undoTurn'>): RunsBrowser {
  return new RunsBrowser({
    fetch: (filter, cursor, limit) => api.runs.call({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) }),
    key: (run) => run.id,
    failure: "Couldn't load runs.",
    limit: BROWSER_PAGE,
    one: (run) => chat.run.call({ run }),
    oneFailure: "Couldn't load this run.",
  }, chat);
}

/** LLM calls, newest first; a call opens with what the model saw and said. */
export function llmBrowser(api: Pick<AdminApi, 'llmCalls'>, chat: Pick<ChatApi, 'llmCall'>): LlmBrowser {
  return new Browser({
    fetch: (filter, cursor, limit) => api.llmCalls.call({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) }),
    key: (call) => call.id,
    failure: "Couldn't load LLM calls.",
    limit: BROWSER_PAGE,
    one: (id) => chat.llmCall.call({ id }),
    oneFailure: "Couldn't load this LLM call.",
  }, {});
}

/** Resources the hub knows; one opens with its text and links, in its viewer. */
export function resourcesBrowser(api: Pick<AdminApi, 'resources'>, chat: Pick<ChatApi, 'resource'>): ResourcesBrowser {
  return new Browser({
    fetch: (filter, cursor, limit) => api.resources.call({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) }),
    key: (resource) => resource.uri,
    failure: "Couldn't load resources.",
    limit: BROWSER_PAGE,
    one: (uri) => chat.resource.call({ uri, want: ['text', 'links'] }),
    oneFailure: "Couldn't open this resource.",
  }, {});
}
