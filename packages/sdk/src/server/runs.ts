/**
 * The runs on this system. A run settles exactly once: its outcome goes to the journal before the reply, a run the
 * hub sends again (same `RunId`, after a dropped link) is answered from the journal, and one sent again while still
 * running joins the run already going.
 */
import type { ControlReply, HandlerAnswer, Json, OutcomeWire, RunId, RunRequest, RunUpdate } from '@harness/core';
import type { OutcomeJournal } from './journal.ts';
import { ActiveRun, type RunEnvironment } from './run.ts';
import type { SystemTable } from './table.ts';
import { fnError } from './wire.ts';

/** Runs by id, with the journal behind them. */
export class RunRegistry {
  readonly #table: SystemTable;
  readonly #journal: OutcomeJournal;
  readonly #env: RunEnvironment;
  readonly #active = new Map<RunId, ActiveRun>();
  readonly #idle = new Set<() => void>();

  constructor(table: SystemTable, journal: OutcomeJournal, env: RunEnvironment) {
    this.#table = table;
    this.#journal = journal;
    this.#env = env;
  }

  /** How many runs are going. */
  get size(): number { return this.#active.size; }

  /** Run a request, or answer it from the journal or the run already going. */
  async run(request: RunRequest): Promise<OutcomeWire> {
    const id = request.run.id;
    const going = this.#active.get(id);
    if (going !== undefined) { return going.outcome(); }
    const settled = await this.#journal.get(id);
    if (settled !== undefined) { return settled; }
    const target = this.#table.target(request.fn, request.kind);
    if (typeof target === 'string') {
      return { status: 'failed', error: fnError('fatal', target, { code: 'not-found' }) };
    }
    const run = new ActiveRun(request, target, this.#env);
    this.#active.set(id, run);
    try {
      const outcome = await run.outcome();
      await this.#journal.put(id, outcome);
      return outcome;
    } finally {
      this.#active.delete(id);
      if (this.#active.size === 0) {
        for (const wake of this.#idle) { wake(); }
        this.#idle.clear();
      }
    }
  }

  /** Resolves when no run is going. */
  idle(): Promise<void> {
    if (this.#active.size === 0) { return Promise.resolve(); }
    return new Promise((resolve) => { this.#idle.add(resolve); });
  }

  control(run: RunId, action: 'cancel' | 'pause'): Promise<ControlReply> {
    const active = this.#active.get(run);
    return active === undefined ? Promise.resolve({ accepted: false, reason: `Run ${run} is not running here.` }) : active.control(action);
  }

  /** A form submission for a waiting run. */
  form(run: RunId, value: Json): void {
    const active = this.#active.get(run);
    if (active === undefined) { throw new Error(`Run ${run} is not running here.`); }
    active.submit(value);
  }

  /** A handler call the hub relays from a child of one of these runs. */
  answer(run: RunId, key: string, handler: string, args: Json): Promise<HandlerAnswer> {
    const active = this.#active.get(run);
    if (active === undefined) {
      return Promise.resolve({ ok: false, error: fnError('caller', `Run ${run} is not running here any more.`, { code: 'gone' }) });
    }
    return active.calls.answer(key, handler, args);
  }

  /** The hub created, or updated, a child of one of these runs. */
  child(parent: RunId, key: string, run: RunId, update: RunUpdate | undefined): void {
    this.#active.get(parent)?.calls.heard(key, run, update);
  }

  /** Cancel every run (the system is stopping). */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.#active.values()].map((run) => run.control('cancel')));
  }
}
