/**
 * Undoing a turn: every run of the turn that left an undo payload is undone through its system, newest first, and
 * the session state each run changed is put back. The session goes back to how the turn found it (`Turn.start`): its
 * transcript is cut back to before the turn, and the fns, context and graph selection the agent had loaded are put
 * back, so a retry starts again from before the turn and never reads it. Runs that changed something but can't be
 * undone are reported, and the hub posts a note in the session saying what happened. Turns are undone newest first:
 * a turn with a later one still standing is refused, since the later one was built on it. An A/B compared turn keeps
 * what its variants did outside the chat (all of them before one was chosen, the discarded ones after): undo leaves it as
 * it is and lists it by variant (`UndoReport.kept`), and the note carries it as a `kept-effects` part.
 */
import { mintId, READ_TAG, TurnStatus, type ActorId, type ChatMessage, type QualifiedName, type Run, type Session, type MessagePart, type Turn, type TurnId, type UndoReport } from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import { AGENT_KIND } from '../execution/index.ts';
import type { CompareService, StateService, UndoService } from './index.ts';
import { isActiveRun, type StoreSessionService } from './sessions.ts';
import { someRows } from '../store/rows.ts';

/** The tag of fns that only read, so a turn that ran them has nothing to undo there. */
export { READ_TAG };

/** Every turn status but undone: the turns still standing. */
const STANDING = TurnStatus.options.filter((status) => status !== 'undone');

/** How many of something, in words. */
function count(n: number, one: string, many: string): string {
  return n === 1 ? `one ${one}` : `${n} ${many}`;
}

/** The note the hub posts after undoing a turn. */
export function undoNote(report: UndoReport): string {
  const lines: string[] = [];
  const session = report.session;
  const rewound = session !== undefined && (session.messages > 0 || session.unloaded.length > 0 || session.reloaded.length > 0);
  const kept = report.kept ?? [];
  if (report.undone.length === 0 && report.failed.length === 0 && report.notUndoable.length === 0 && kept.length === 0 && !rewound) { lines.push('Undid the turn. It had changed nothing.'); }
  if (session !== undefined && session.messages > 0) { lines.push(`Took the turn's ${count(session.messages, 'message', 'messages')} out of the conversation, so the agent starts again from before it.`); }
  if (session !== undefined && session.unloaded.length > 0) { lines.push(`Unloaded what the turn loaded: ${session.unloaded.join(', ')}.`); }
  if (session !== undefined && session.reloaded.length > 0) { lines.push(`Loaded again what the turn dropped: ${session.reloaded.join(', ')}.`); }
  if (report.undone.length > 0) { lines.push(`Undid ${count(report.undone.length, 'change', 'changes')}:`, ...report.undone.map((u) => `- ${u.fn}: ${u.summary}`)); }
  if (report.failed.length > 0) { lines.push('Could not undo:', ...report.failed.map((f) => `- ${f.fn}: ${f.error.message}`)); }
  if (report.notUndoable.length > 0) { lines.push('These have no undo and were left as they are:', ...report.notUndoable.map((n) => `- ${n.fn}`)); }
  if (kept.length > 0) {
    lines.push(`What the variants did stays as it is: ${kept.map((k) => `${count(k.effects.length, 'change', 'changes')} by ${k.label}`).join(', ')}.`);
  }
  return lines.join('\n');
}

/** The parts of the note the hub posts after undoing a turn: its words, and what the variants did that stays, by variant. */
export function undoNoteParts(report: UndoReport): MessagePart[] {
  const text: MessagePart = { type: 'text', text: undoNote(report) };
  return report.kept === undefined || report.kept.length === 0 ? [text] : [text, { type: 'kept-effects', variants: report.kept }];
}

/** Undo on the store, through the run service. */
export class RunUndoService implements UndoService {
  readonly #deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'runs' | 'catalog' | 'hubActor'>;
  readonly #sessions: StoreSessionService;
  readonly #state: StateService;
  readonly #compare: Pick<CompareService, 'kept'>;

  constructor(
    deps: Pick<ChatDeps, 'store' | 'clock' | 'random' | 'bus' | 'log' | 'settings' | 'runs' | 'catalog' | 'hubActor'>, sessions: StoreSessionService, state: StateService,
    compare: Pick<CompareService, 'kept'>,
  ) {
    this.#deps = deps;
    this.#sessions = sessions;
    this.#state = state;
    this.#compare = compare;
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
    if (turn.session !== undefined && await this.#deps.store.table('turns').count({ session: turn.session, createdAt: { gt: turn.createdAt }, status: { in: STANDING } }) > 0) {
      throw new ChatError('conflict', 'A later turn was built on this one. Undo the later turns first.');
    }
    const runs = await someRows(this.#deps.store.table('runs'), { where: { turn: id }, order: [['createdAt', 'desc']] }, this.#deps.settings.chat.HARNESS_UNDO_RUNS);
    // A run still going in the background could change things after its undo, so the turn waits until all have ended.
    if (runs.some(isActiveRun)) { throw new ChatError('conflict', 'Some runs of this turn are still going. Undo it once they finish.'); }
    const report: UndoReport = { turn: id, undone: [], failed: [], notUndoable: [] };
    for (const run of runs) { await this.#undoRun(run, by, report); }
    const kept = await this.#compare.kept(turn);
    if (kept.length > 0) { report.kept = kept; }
    const rewound = await this.#rewind(turn);
    if (rewound !== undefined) { report.session = rewound; } else if (turn.session !== undefined) { await this.#sessions.save(turn.session, {}); }
    await this.#deps.store.table('turns').update(id, { status: 'undone' });
    this.#deps.log.info('chat.turn.undone', {
      turn: id, by, undone: report.undone.length, failed: report.failed.length, notUndoable: report.notUndoable.length, kept: kept.reduce((n, k) => n + k.effects.length, 0), messages: report.session?.messages ?? null,
    });
    if (turn.session !== undefined) {
      const note: ChatMessage = {
        id: mintId('message', this.#deps.random), session: turn.session, turn: id, author: this.#deps.hubActor, role: 'note', parts: undoNoteParts(report),
        runs: runs.map((r) => r.id), status: 'done', replyAll: false, answerers: [], createdAt: this.#deps.clock(),
      };
      await this.#deps.store.table('messages').insert(note);
      this.#deps.bus.publish('message', { message: note });
      this.#deps.bus.publish('session.controls', { session: turn.session, controls: await this.#sessions.controls(turn.session) });
    }
    return report;
  }

  /**
   * Put the session back the way the turn found it: the transcript cut to its length then, the loaded fns, context and
   * graph selection as they were. What changed, for the report; undefined for a turn that kept no start.
   */
  async #rewind(turn: Turn): Promise<UndoReport['session']> {
    const start = turn.start;
    const id = turn.session;
    if (id === undefined || start === undefined) { return undefined; }
    // in one transaction with the read, so a background result landing now isn't lost or doubled
    const rewound = await this.#deps.store.tx(async (tx): Promise<{ session: Session; report: NonNullable<UndoReport['session']> } | undefined> => {
      const session = await tx.table('sessions').get(id);
      if (session === undefined) { return undefined; }
      const loaded = [...session.tools, ...session.context];
      const before = [...start.tools, ...start.context];
      const { selection: _selection, suggested: _suggested, announcedSystems: _announced, citationsTold: _told, ...rest } = session;
      // what the undone turn was suggested goes too: the model never read it, so a retry may be suggested it again;
      // so do the system changes it was told, which a retry tells again
      const restored = await tx.table('sessions').put({
        ...rest, transcript: session.transcript.slice(0, start.transcript), tools: [...start.tools], context: [...start.context],
        ...(start.selection === undefined ? {} : { selection: start.selection }), ...(start.suggested === undefined ? {} : { suggested: [...start.suggested] }),
        ...(start.announcedSystems === undefined ? {} : { announcedSystems: start.announcedSystems }),
        ...(start.citationsTold === undefined ? {} : { citationsTold: start.citationsTold }), updatedAt: this.#deps.clock(),
      });
      return {
        session: restored,
        report: { messages: Math.max(0, session.transcript.length - start.transcript), unloaded: missingFrom(loaded, before), reloaded: missingFrom(before, loaded) },
      };
    });
    if (rewound === undefined) { return undefined; }
    this.#sessions.changed(rewound.session);
    return rewound.report;
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
    if (run.undo === undefined && run.status === 'done' && run.kind !== AGENT_KIND && !(await this.#readOnly(run))) {
      report.notUndoable.push({ run: run.id, fn: run.fn });
    }
  }

  async #readOnly(run: Run): Promise<boolean> {
    return (await this.#deps.catalog.fn(run.fn))?.decl.tags.includes(READ_TAG) ?? false;
  }
}

/** The names of `names` that `others` lacks, once each, in order. */
function missingFrom(names: readonly QualifiedName[], others: readonly QualifiedName[]): QualifiedName[] {
  const known = new Set(others);
  return [...new Set(names)].filter((name) => !known.has(name));
}
