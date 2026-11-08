/**
 * The chat's inspectors: one run's full record (the drawer), a turn's fn tree (live while the turn runs: asked
 * again, debounced, as its runs change), LLM calls by id (each fetched once), and the resource being viewed.
 * They hold what the panels show and nothing else; the panels follow the URL.
 */
import type { LlmInteraction, LlmInteractionId, ResourceRead, ResourceUri, Run, RunId, TreeNode, TurnId } from '@harness/core';
import { ref, shallowRef } from 'vue';
import { problemText } from '../../state/problems.ts';
import { Loaded } from '../../state/loaded.ts';
import type { ChatApi } from '../api.ts';
import { treeCalls } from '../logic/inspect.ts';

/** The run drawer, the turn tree and the LLM call inspector. */
export class Inspector {
  readonly #api: Pick<ChatApi, 'run' | 'tree' | 'treeRefresh' | 'llmCall' | 'resource'>;

  readonly run = new Loaded<Run>();
  readonly tree = new Loaded<TreeNode>();
  readonly treeTurn = ref<TurnId | undefined>(undefined);
  readonly resource = new Loaded<ResourceRead>();
  readonly calls = shallowRef<ReadonlyMap<LlmInteractionId, LlmInteraction>>(new Map());
  readonly callProblems = shallowRef<ReadonlyMap<LlmInteractionId, string>>(new Map());

  constructor(api: Pick<ChatApi, 'run' | 'tree' | 'treeRefresh' | 'llmCall' | 'resource'>) {
    this.#api = api;
  }

  /** Load one run's record for the drawer. */
  async openRun(id: RunId): Promise<void> {
    if (this.run.value.value?.id !== id) { this.run.reset(); }
    await this.run.load(() => this.#api.run.call({ run: id }), "Couldn't load this run.", this.run.value.value?.id === id);
  }

  /** Read a resource for the viewer: its text (converted, for documents) and its links. */
  async openResource(uri: ResourceUri): Promise<void> {
    if (this.resource.value.value?.stat.uri !== uri) { this.resource.reset(); }
    await this.resource.load(() => this.#api.resource.call({ uri, want: ['text', 'links'] }), "Couldn't open this.");
  }

  /** Load a turn's tree. */
  async openTree(turn: TurnId): Promise<void> {
    if (this.treeTurn.value !== turn) { this.tree.reset(); }
    this.treeTurn.value = turn;
    await this.tree.load(() => this.#api.tree.call({ turn }), "Couldn't load this turn's tree.");
  }

  /** Ask for the open tree again once changes pause (the `treeRefresh` caller's debounce; the newest ask wins). */
  refreshTree(): void {
    const turn = this.treeTurn.value;
    if (turn === undefined) { return; }
    void this.tree.load(() => this.#api.treeRefresh.call({ turn }), "Couldn't refresh this turn's tree.", true);
  }

  closeTree(): void {
    this.#api.treeRefresh.cancel();
    this.treeTurn.value = undefined;
    this.tree.reset();
  }

  /** Fetch LLM calls not yet held. */
  async loadCalls(ids: readonly LlmInteractionId[]): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => !this.calls.value.has(id));
    await Promise.all(wanted.map(async (id) => {
      try {
        const call = await this.#api.llmCall.call({ id });
        const calls = new Map(this.calls.value);
        calls.set(id, call);
        this.calls.value = calls;
      } catch (error) {
        const problems = new Map(this.callProblems.value);
        problems.set(id, problemText(error, "Couldn't load this LLM call."));
        this.callProblems.value = problems;
      }
    }));
  }

  /** The LLM calls of a turn: its tree's, fetched. */
  async loadTurn(turn: TurnId): Promise<LlmInteraction[]> {
    await this.openTree(turn);
    const tree = this.tree.value.value;
    if (tree === undefined) { return []; }
    const ids = treeCalls(tree);
    await this.loadCalls(ids);
    return ids.flatMap((id) => {
      const call = this.calls.value.get(id);
      return call === undefined ? [] : [call];
    });
  }

  dispose(): void {
    this.#api.treeRefresh.cancel();
  }
}

