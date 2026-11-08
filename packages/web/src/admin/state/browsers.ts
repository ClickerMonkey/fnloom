/**
 * The browsers: runs, LLM calls, model calls and resources. Each is a list paged for a filter (taken from the URL by
 * its page: the list's query, which the hub filters and sorts) and the one item opened beside it, fetched whole. One
 * class, four sources.
 */
import type { ListQuery, LlmInteraction, LlmInteractionId, ModelCall, ModelCallId, ResourceRead, ResourceRecord, ResourceUri, Run, RunId, TurnId, UndoReport } from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded, Paged, Task, type PagedSource, type Outcome } from '../../state/loaded.ts';
import type { ChatApi } from '../../chat/api.ts';
import type { AdminApi } from '../api.ts';
import type { LlmSummary, ResourceFilter } from '@harness/core';

/** The model calls browser's filter: the list's query, and the run they were made for (a link from a run). */
export interface ModelCallsFilter {
  readonly query: ListQuery;
  readonly run?: RunId;
}

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
export class RunsBrowser extends Browser<Run, ListQuery, RunId, Run> {
  readonly #chat: Pick<ChatApi, 'background' | 'undoTurn'>;
  readonly control = new Task();

  constructor(source: BrowserSource<Run, ListQuery, RunId, Run>, chat: Pick<ChatApi, 'background' | 'undoTurn'>) {
    super(source, {});
    this.#chat = chat;
  }

  /** Stop the agent waiting for a run; the run carries on. */
  async background(run: RunId): Promise<Outcome<{ accepted: boolean }>> {
    const result = await this.control.run(() => this.#chat.background.call({ run }), "Couldn't move it to the background.");
    if (result.ok) { void this.open(run); }
    return result;
  }

  /** Undo everything a turn did that can be undone. */
  async undoTurn(turn: TurnId): Promise<Outcome<UndoReport>> {
    const result = await this.control.run(() => this.#chat.undoTurn.call({ turn }), "Couldn't undo the turn.");
    if (result.ok) { void this.list.refresh(); }
    return result;
  }
}

export type LlmBrowser = Browser<LlmSummary, ListQuery, LlmInteractionId, LlmInteraction>;

/** A model call opened: its record and, for a chat call, the whole request and response. */
export interface OpenedModelCall {
  readonly call: ModelCall;
  readonly interaction?: LlmInteraction;
}
export type ModelCallsBrowser = Browser<ModelCall, ModelCallsFilter, ModelCallId, OpenedModelCall>;
export type ResourcesBrowser = Browser<ResourceRecord, ResourceFilter, ResourceUri, ResourceRead>;

/** Runs, newest first; a run opens with its full record. */
export function runsBrowser(api: Pick<AdminApi, 'runs'>, chat: Pick<ChatApi, 'run' | 'background' | 'undoTurn'>): RunsBrowser {
  return new RunsBrowser({
    fetch: (query, cursor, limit) => api.runs.call({ query, limit, ...(cursor === undefined ? {} : { cursor }) }),
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
    fetch: (query, cursor, limit) => api.llmCalls.call({ query, limit, ...(cursor === undefined ? {} : { cursor }) }),
    key: (call) => call.id,
    failure: "Couldn't load LLM calls.",
    limit: BROWSER_PAGE,
    one: (id) => chat.llmCall.call({ id }),
    oneFailure: "Couldn't load this LLM call.",
  }, {});
}

/** Every model call of every modality, newest first; a chat call opens with its interaction (what the model saw and said). */
export function modelCallsBrowser(api: Pick<AdminApi, 'modelCalls' | 'modelCall'>, chat: Pick<ChatApi, 'llmCall'>): ModelCallsBrowser {
  return new Browser({
    fetch: (filter, cursor, limit) => api.modelCalls.call({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) }),
    key: (call) => call.id,
    failure: "Couldn't load model calls.",
    limit: BROWSER_PAGE,
    one: async (id) => {
      const call = await api.modelCall.call({ id });
      return call.interaction === undefined ? { call } : { call, interaction: await chat.llmCall.call({ id: call.interaction }) };
    },
    oneFailure: "Couldn't load this model call.",
  }, { query: {} });
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
