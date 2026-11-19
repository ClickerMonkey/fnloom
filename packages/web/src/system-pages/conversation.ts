/**
 * A system page's conversation (`components.Conversation`, item 8) as the chat's own parts take it: each person's
 * message a `ChatMessage` for `UserMessage`, each answer a message whose pieces (words, reasoning, calls) are its
 * segments in order for `AssistantAnswer`, and each call a `RunView` for the chat's run cards and run folds. Pure, so
 * the mapping is tested alone; nothing here is stored or sent to the hub.
 */
import { ActorId, MessageId, RunId, SessionId, TurnId, type ChatMessage, type QualifiedName } from '@harness/core';
import type { ConversationCall, ConversationEntry, ConversationPiece } from '@harness/sdk';
import { emptyRun, type RunView } from '../chat/logic/runs.ts';
import { addSegment, type AnswerSegment } from '../chat/logic/thread.ts';

/** One conversation entry as the chat's parts draw it. */
export type ConversationItem =
  | { readonly kind: 'user'; readonly key: string; readonly message: ChatMessage }
  | { readonly kind: 'answer'; readonly key: string; readonly message: ChatMessage; readonly segments: readonly AnswerSegment[]; readonly runs: readonly RunView[] }
  | { readonly kind: 'note'; readonly key: string; readonly message: ChatMessage };

/** The session the drawn messages say they are in: none (they are never stored). */
const NO_SESSION = SessionId.parse('ses_page');
/** Who the answers are by, for the parts that ask (the agent's name is drawn from the `agent` prop). */
export const PAGE_AGENT = ActorId.parse('act_page-agent');
/** The time of an entry that has none: the chat's parts leave its time out. */
export const NO_TIME = 0;

/** A call as the chat's run card takes it: its fn is `<system>/<tool>`, labelled by the tool's name. */
export function callRun(system: string, call: ConversationCall): RunView {
  const fn: QualifiedName = `${system}/${call.name}`;
  const base: RunView = { ...emptyRun(RunId.parse(`run_${call.key}`), fn, call.status), args: call.args };
  switch (call.status) {
    case 'running': return base;
    case 'done': return { ...base, outcome: { status: 'done', result: call.output ?? '' } };
    case 'failed': return { ...base, outcome: { status: 'failed', error: { class: 'fatal', code: 'failed', message: call.output === undefined || call.output.trim() === '' ? 'It failed.' : call.output } } };
  }
}

function message(key: string, author: ActorId, role: ChatMessage['role'], text: string, at: number | undefined, runs: readonly RunId[], streaming: boolean): ChatMessage {
  return {
    id: MessageId.parse(`msg_${key}`), session: NO_SESSION, turn: TurnId.parse(`trn_${key}`), author, role,
    parts: text === '' ? [] : [{ type: 'text', text }], runs: [...runs], status: streaming ? 'streaming' : 'done', replyAll: false, answerers: [],
    createdAt: at ?? NO_TIME,
  };
}

/** An answer's pieces as the chat's segments, in order, with the runs of its calls. */
function segmentsOf(system: string, pieces: readonly ConversationPiece[]): { segments: AnswerSegment[]; runs: RunView[] } {
  const runs: RunView[] = [];
  const segments = pieces.reduce<AnswerSegment[]>((done, piece) => {
    if (piece.kind !== 'call') { return piece.text.trim() === '' ? done : addSegment(done, { kind: piece.kind, text: piece.text }); }
    const run = callRun(system, piece.call);
    runs.push(run);
    return addSegment(done, { kind: 'runs', runs: [run.id] });
  }, []);
  return { segments, runs };
}

/**
 * The entries as the chat's parts draw them. `me` is the person (their messages are theirs); the last answer is
 * `streaming` while it is still arriving.
 */
export function conversationItems(entries: readonly ConversationEntry[], options: { readonly system: string; readonly me: ActorId; readonly streaming: boolean }): ConversationItem[] {
  const lastAnswer = entries.findLastIndex((entry) => entry.kind === 'answer');
  return entries.map((entry, i): ConversationItem => {
    switch (entry.kind) {
      case 'user': return { kind: 'user', key: entry.key, message: message(entry.key, options.me, 'user', entry.text, entry.at, [], false) };
      case 'note': return { kind: 'note', key: entry.key, message: message(entry.key, PAGE_AGENT, 'note', entry.text, undefined, [], false) };
      case 'answer': {
        const { segments, runs } = segmentsOf(options.system, entry.pieces);
        const text = entry.pieces.flatMap((piece) => (piece.kind === 'text' ? [piece.text] : [])).join('');
        const streaming = options.streaming && i === lastAnswer;
        return { kind: 'answer', key: entry.key, message: message(entry.key, PAGE_AGENT, 'assistant', text, entry.at, runs.map((run) => run.id), streaming), segments, runs };
      }
    }
  });
}
