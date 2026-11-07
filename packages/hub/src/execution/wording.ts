/**
 * Run wording: the words a run says it is doing in its current phase, from its fn's status templates, then its
 * kind's, then the hub's defaults (core `resolveStatus`). The run service stores them on the run and sends them with
 * every `status` update, so the browser never builds them.
 */
import { phaseOf, resolveStatus, type FnRecord, type OutcomeWire, type Run, type RunStatus, type RunText } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';

/** Where a run is going: its next status, and the attempt and outcome that come with it when they change. */
export interface RunStep {
  readonly status: RunStatus;
  readonly attempt?: number | undefined;
  readonly outcome?: OutcomeWire | undefined;
}

/** Words runs from their fns' and kinds' status templates. */
export class RunWording {
  readonly #catalog: Pick<Catalog, 'fn' | 'kind'>;

  constructor(catalog: Pick<Catalog, 'fn' | 'kind'>) {
    this.#catalog = catalog;
  }

  /**
   * The words for a run's next step, or undefined when its new status has no phase (approval, paused, cancelled,
   * undone: the chat words those itself). `fn` saves a lookup when the caller has the record already.
   */
  async text(run: Pick<Run, 'fn' | 'args' | 'attempt' | 'outcome'>, step: RunStep, fn?: FnRecord): Promise<RunText | undefined> {
    const phase = phaseOf(step.status, step.attempt ?? run.attempt);
    if (phase === undefined) return undefined;
    const record = fn ?? await this.#catalog.fn(run.fn);
    const kind = record === undefined || record.decl.kind === 'native' ? undefined : await this.#catalog.kind(record.decl.kind);
    const outcome = step.outcome ?? run.outcome;
    return resolveStatus([record?.decl.status, kind?.decl.status], phase, {
      fn: run.fn, args: run.args, ...(outcome?.status === 'done' ? { output: outcome.result } : {}),
    });
  }
}
