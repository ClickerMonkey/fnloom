/**
 * Sending a draft: what the composer holds goes to the thread, the box empties at once (the files stay staged until
 * the hub has the message), and a failed send puts everything back exactly. An edit undoes the turns from the edited
 * message on, then sends. Runs going when a message is sent move to the background; the result says how many.
 */
import { isActive } from '../logic/runs.ts';
import type { ComposerStore } from './composer.ts';
import type { DraftSuggestions } from './suggest.ts';
import type { ThreadStore, UndoSummary } from './thread.ts';
import type { Outcome } from '../../ui/index.ts';

/** How a send went. */
export type SendResult = Outcome<{ readonly moved: number; readonly undone: UndoSummary | undefined }>;

/** Send what the composer holds. */
export async function sendDraft(thread: ThreadStore, composer: ComposerStore, suggestions?: DraftSuggestions): Promise<SendResult> {
  const outgoing = composer.outgoing();
  if (outgoing === undefined || thread.sending.value) { return { ok: false, problem: '' }; }
  const editing = composer.editing.value;
  const moved = thread.running.value ? [...thread.runs.value.values()].filter((run) => isActive(run.status) && !run.background).length : 0;
  const snapshot = composer.snapshot();
  composer.clear('keep');
  suggestions?.clear();
  if (editing !== undefined) {
    const undone = await thread.editResend(editing, outgoing.parts);
    if (undone !== undefined) {
      composer.uploads.clear();
      return { ok: true, value: { moved: 0, undone } };
    }
  } else if (await thread.send(outgoing)) {
    composer.uploads.clear();
    return { ok: true, value: { moved, undone: undefined } };
  }
  composer.restore(snapshot);
  return { ok: false, problem: thread.problem.value };
}
