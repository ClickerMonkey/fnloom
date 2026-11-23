/**
 * One run for its own person's run page (`/run/:run`): its record, its turn's tree (the page draws the run's own
 * branch), its approval while one waits, and what may be done to it (answer the approval, move it to the background,
 * undo its turn). Every read goes through the hub's person-scoped run endpoints, so a person sees only runs they may
 * (their own, and those of chats they are in); a run they may not see reads as missing. Refreshed quietly while it
 * is going, so a page left open follows it to its end.
 */
import type { Approval, Json, Run, RunId, TreeNode, UndoReport } from '@harness/core';
import { computed, shallowRef } from 'vue';
import type { ChatApi } from '../chat/api.ts';
import { Loaded, Task, type Outcome } from '../state/loaded.ts';
import { branchOf } from './logic.ts';

/** The callers the page uses. */
export type RunPageApi = Pick<ChatApi, 'run' | 'tree' | 'approvals' | 'approve' | 'undoTurn' | 'background'>;

/** One run, its branch of the tree, its approval, and what may be done to it. */
export class RunPageStore {
  readonly #api: RunPageApi;
  readonly run = new Loaded<Run>();
  /** Its turn's whole tree; `branch` is this run's part of it. */
  readonly tree = new Loaded<TreeNode>();
  /** Its pending approval, while it waits for one. */
  readonly approval = shallowRef<Approval | undefined>(undefined);
  readonly acting = new Task();
  /** The run shown. */
  readonly id = shallowRef<RunId | undefined>(undefined);
  /** The run's own branch of its turn's tree. */
  readonly branch = computed(() => (this.id.value === undefined ? undefined : branchOf(this.tree.value.value, this.id.value)));

  constructor(api: RunPageApi) {
    this.#api = api;
  }

  /** Show a run: its record first, then its tree and approval. */
  async open(id: RunId): Promise<void> {
    if (this.id.value !== id) {
      this.id.value = id;
      this.run.reset();
      this.tree.reset();
      this.approval.value = undefined;
    }
    await this.#load(id, false);
  }

  /** Ask again without the loading state (the page's live refresh, and after an action). */
  async refresh(): Promise<void> {
    const id = this.id.value;
    if (id !== undefined) { await this.#load(id, true); }
  }

  /** Answer its approval once; false (with `acting.problem`) when the hub refused. */
  async decide(approve: boolean, reason: string, answer: Json | undefined): Promise<boolean> {
    const waiting = this.approval.value;
    if (waiting === undefined) { return false; }
    const result = await this.acting.run(() => this.#api.approve.call({
      approval: waiting.id, approve, remember: 'once', ...(reason === '' ? {} : { reason }), ...(answer === undefined ? {} : { answer }),
    }), "Couldn't send your answer.");
    if (result.ok) { this.approval.value = undefined; void this.refresh(); }
    return result.ok;
  }

  /** Undo its turn: it and everything it called. */
  async undo(): Promise<Outcome<UndoReport>> {
    const run = this.run.value.value;
    if (run === undefined) { return { ok: false, problem: 'The run has not loaded yet.' }; }
    const result = await this.acting.run(() => this.#api.undoTurn.call({ turn: run.turn }), "Couldn't undo it.");
    if (result.ok) { await this.refresh(); }
    return result;
  }

  /** Move it to the background, so whatever waits on it stops waiting. */
  async background(): Promise<Outcome<boolean>> {
    const run = this.run.value.value;
    if (run === undefined) { return { ok: false, problem: 'The run has not loaded yet.' }; }
    const result = await this.acting.run(async () => (await this.#api.background.call({ run: run.id })).accepted, "Couldn't move it to the background.");
    if (result.ok) { void this.refresh(); }
    return result;
  }

  async #load(id: RunId, quiet: boolean): Promise<void> {
    await this.run.load(() => this.#api.run.call({ run: id }), "Couldn't load this run.", quiet);
    const run = this.run.value.value;
    if (run === undefined || run.id !== id || this.id.value !== id) { return; }
    await Promise.all([
      // a turn with nothing recorded yet has no tree; the page then shows none
      this.tree.load(() => this.#api.tree.call({ turn: run.turn }), "Couldn't load what it called.", quiet || this.tree.value.value !== undefined),
      this.#loadApproval(run),
    ]);
  }

  async #loadApproval(run: Run): Promise<void> {
    if (run.status !== 'awaiting-approval') { this.approval.value = undefined; return; }
    try {
      const found = await this.#api.approvals.call({ runs: [run.id] });
      if (this.id.value === run.id) { this.approval.value = found.find((a) => a.run === run.id && a.status === 'pending'); }
    } catch {
      // the run's record still says it waits; the page offers the inbox instead of the card
      if (this.id.value === run.id) { this.approval.value = undefined; }
    }
  }
}
