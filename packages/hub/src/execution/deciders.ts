/**
 * Deciding approvals that name no person. A judge (`{ by: 'judge', fn }`) is an `llm` fn run like any other, given
 * the waiting call as a `JudgeRequest` and answering a `Verdict`. The hub (`{ by: 'hub' }`) decides by its own rule, a
 * quota: it allows the call while the turn has budget left and refuses it once that is used up. Decisions are recorded
 * as the hub's own actor.
 */
import { JudgeRequest, Verdict, type ActorId, type Approval, type QualifiedName, type Run } from '@harness/core';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Ledger, RunService } from './index.ts';
import { rows } from './pages.ts';
import type { ApprovalDeciders } from './policies.ts';
import type { ExecutionBase } from './ports.ts';

/** The hub's own actor, which decisions without a person are recorded as. */
export async function hubActorOf(store: ExecutionBase['store']): Promise<ActorId> {
  for await (const actor of rows(store.table('actors'), { where: { kind: 'system' } })) {
    if (actor.kind === 'system' && actor.system === HUB_SYSTEM) return actor.id;
  }
  throw new Error('the hub has no actor to decide as');
}

/** What the deciders need. */
export interface DecidersDeps extends Pick<ExecutionBase, 'store'> {
  readonly runs: Pick<RunService, 'start'>;
  readonly ledger: Pick<Ledger, 'remaining'>;
}

/** Judges run through the run service; the hub's rule reads the ledger. */
export class RunDeciders implements ApprovalDeciders {
  readonly #deps: DecidersDeps;

  constructor(deps: DecidersDeps) {
    this.#deps = deps;
  }

  actor(): Promise<ActorId> {
    return hubActorOf(this.#deps.store);
  }

  async judge(judge: QualifiedName, approval: Approval, run: Run): Promise<Verdict> {
    const request: JudgeRequest = { fn: approval.fn, args: run.args, actor: run.actor };
    const { settled } = await this.#deps.runs.start({
      fn: judge, args: JudgeRequest.parse(request), turn: run.turn, ...(run.session === undefined ? {} : { session: run.session }),
      key: `judge:${approval.id}`, actor: run.actor, caller: await this.actor(), priority: run.priority, background: false, handlers: [],
    });
    const outcome = await settled;
    if (outcome.status !== 'done') return { approve: false, reason: `the judge ${judge} gave no verdict (it ended ${outcome.status})` };
    const verdict = Verdict.safeParse(outcome.result);
    return verdict.success ? verdict.data : { approve: false, reason: `the judge ${judge} answered something other than a verdict` };
  }

  async hub(approval: Approval, run: Run): Promise<Verdict> {
    const turn = await this.#deps.store.table('turns').get(run.turn);
    if (turn === undefined) return { approve: false, reason: `the turn of ${approval.fn} is gone` };
    const left = await this.#deps.ledger.remaining(turn.limits, { turn: turn.id, actor: run.actor });
    return left.cost > 0
      ? { approve: true, reason: `within ${left.limitedBy} ($${left.cost.toFixed(2)} left)` }
      : { approve: false, reason: `${left.limitedBy} is used up` };
  }
}
