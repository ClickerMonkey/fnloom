/**
 * Approvals outside a chat (the inbox): the pending approvals of the runs the inbox points at, read from the hub with
 * what each run would do (`approvals`), and answered from there. An answered one leaves at once and comes back if the
 * hub refuses the answer.
 */
import type { Approval, RunId } from '@harness/core';
import { ref, shallowRef } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** The most runs asked about at once (the endpoint's bound). */
export const APPROVALS_ASKED = 200;

/** The pending approvals of some runs, by run. */
export class ApprovalDesk {
  readonly #api: Pick<ChatApi, 'approvals' | 'approve'>;
  readonly #asked = new Set<RunId>();
  /** Pending approvals, by the run that waits. */
  readonly byRun = shallowRef<ReadonlyMap<RunId, Approval>>(new Map());
  readonly problem = ref('');

  constructor(api: Pick<ChatApi, 'approvals' | 'approve'>) {
    this.#api = api;
  }

  /** Read the approvals of the runs not asked about yet. */
  async load(runs: readonly RunId[]): Promise<void> {
    const fresh = [...new Set(runs)].filter((run) => !this.#asked.has(run)).slice(0, APPROVALS_ASKED);
    if (fresh.length === 0) { return; }
    for (const run of fresh) { this.#asked.add(run); }
    try {
      const found = await this.#api.approvals.call({ runs: fresh });
      const next = new Map(this.byRun.value);
      for (const approval of found) { if (approval.status === 'pending') { next.set(approval.run, approval); } }
      this.byRun.value = next;
      this.problem.value = '';
    } catch (error) {
      for (const run of fresh) { this.#asked.delete(run); }
      this.problem.value = problemText(error);
    }
  }

  /** Approve or decline once; false (with `problem` set) when the hub refused. */
  async decide(approval: Approval, approve: boolean, reason: string): Promise<boolean> {
    const before = this.byRun.value;
    const next = new Map(before);
    next.delete(approval.run);
    this.byRun.value = next;
    try {
      await this.#api.approve.call({ approval: approval.id, approve, remember: 'once', ...(reason === '' ? {} : { reason }) });
      return true;
    } catch (error) {
      this.byRun.value = before;
      this.problem.value = problemText(error);
      return false;
    }
  }
}
