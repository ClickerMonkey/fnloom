/**
 * Undoing a turn: every run of the turn that left an undo payload is undone through its system, newest first, and
 * the session state each run changed is put back. Runs that changed something but can't be undone are reported, and
 * the hub posts a note in the session saying what happened.
 */
import { mintId, type ActorId, type ChatMessage, type Run, type TurnId, type UndoReport } from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import type { StateService, UndoService } from './index.ts';
import { isActiveRun, type StoreSessionService } from './sessions.ts';
import { readAll } from './support.ts';

/** The tag of fns that only read, so a turn that ran them has nothing to undo there. */
export const READ_TAG = 'read';

/** The note the hub posts after undoing a turn. */
export function undoNote(report: UndoReport): string {
  const lines: string[] = [];
  if (report.undone.length === 0 && report.failed.length === 0 && report.notUndoable.length === 0) { lines.push('Undid the turn. It had changed nothing.'); }
  if (report.undone.length > 0) { lines.push(`Undid ${report.undone.length === 1 ? 'one change' : `${report.undone.length} changes`}:`, ...report.undone.map((u) => `- ${u.fn}: ${u.summary}`)); }
  if (report.failed.length > 0) { lines.push('Could not undo:', ...report.failed.map((f) => `- ${f.fn}: ${f.error.message}`)); }
  if (report.notUndoable.length > 0) { lines.push('These have no undo and were left as they are:', ...report.notUndoable.map((n) => `- ${n.fn}`)); }
  return lines.join('\n');
}

/** Undo on the store, through the run service. */
export class RunUndoService implements UndoService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'runs' | 'catalog' | 'hubActor'>;
  readonly #sessions: StoreSessionService;
  readonly #state: StateService;

  constructor(deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'runs' | 'catalog' | 'hubActor'>, sessions: StoreSessionService, state: StateService) {
    this.#deps = deps;
    this.#sessions = sessions;
    this.#state = state;
  }

  async undoTurn(id: TurnId, by: ActorId): Promise<UndoReport> {
    const turn = await this.#deps.store.table('turns').get(id);
    if (turn === undefined) { throw new ChatError('not-found', `No turn ${id}.`); }
    if (turn.session === undefined) {
      if (turn.actor !== by) { throw new ChatError('not-found', `No turn ${id}.`); }
    } else {
      await this.#sessions.require(turn.session, by);
    }
    if (turn.status === 'running' || turn.status === 'paused') { throw new ChatError('conflict', 'Stop the turn before undoing it.'); }
    if (turn.status === 'undone') { throw new ChatError('conflict', 'This turn was already undone.'); }
    const runs = await readAll(this.#deps.store.table('runs'), { where: { turn: id }, order: [['createdAt', 'desc']] }, this.#deps.settings.chat.HARNESS_UNDO_RUNS);
    // A run still going in the background could change things after its undo, so the turn waits until all have ended.
    if (runs.some(isActiveRun)) { throw new ChatError('conflict', 'Some runs of this turn are still going. Undo it once they finish.'); }
    const report: UndoReport = { turn: id, undone: [], failed: [], notUndoable: [] };
    for (const run of runs) { await this.#undoRun(run, by, report); }
    await this.#deps.store.table('turns').update(id, { status: 'undone' });
    this.#deps.log.info('chat.turn.undone', { turn: id, by, undone: report.undone.length, failed: report.failed.length, notUndoable: report.notUndoable.length });
    if (turn.session !== undefined) {
      const note: ChatMessage = {
        id: mintId('message', this.#deps.random), session: turn.session, turn: id, author: this.#deps.hubActor, role: 'note', parts: [{ type: 'text', text: undoNote(report) }],
        runs: runs.map((r) => r.id), status: 'done', replyAll: false, answerers: [], createdAt: this.#deps.clock(),
      };
      await this.#deps.store.table('messages').insert(note);
      this.#deps.bus.publish('message', { message: note });
      await this.#sessions.save(turn.session, {});
      this.#deps.bus.publish('session.controls', { session: turn.session, controls: await this.#sessions.controls(turn.session) });
    }
    return report;
  }

  async #undoRun(run: Run, by: ActorId, report: UndoReport): Promise<void> {
    if (run.status === 'undone') { return; }
    if (run.undo !== undefined) {
      try {
        const outcome = await this.#deps.runs.undo(run.id, by);
        switch (outcome.status) {
          case 'undone': report.undone.push({ run: run.id, fn: run.fn, summary: outcome.summary }); break;
          case 'gone': report.undone.push({ run: run.id, fn: run.fn, summary: 'Nothing was left to undo.' }); break;
          case 'failed': report.failed.push({ run: run.id, fn: run.fn, error: outcome.error }); return;
        }
      } catch (error) {
        report.failed.push({ run: run.id, fn: run.fn, error: { class: 'fatal', code: 'undo-failed', message: messageOf(error) } });
        return;
      }
    }
    if (run.stateChanges.length > 0) {
      await this.#state.revert(run.id);
      if (run.undo === undefined) { report.undone.push({ run: run.id, fn: run.fn, summary: `Put back ${run.stateChanges.length === 1 ? 'one state field' : `${run.stateChanges.length} state fields`}.` }); }
      return;
    }
    if (run.undo === undefined && run.status === 'done' && run.kind !== 'hub/llm' && !(await this.#readOnly(run))) {
      report.notUndoable.push({ run: run.id, fn: run.fn });
    }
  }

  async #readOnly(run: Run): Promise<boolean> {
    return (await this.#deps.catalog.fn(run.fn))?.decl.tags.includes(READ_TAG) ?? false;
  }
}
