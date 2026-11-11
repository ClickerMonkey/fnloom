/**
 * The thread as it is drawn: messages in order, grouped into rows. All the assistant messages of one turn by one
 * agent become one answer (one avatar, one time), days get separators, and notes sit between them. Also the plain
 * text of a message (for copying and reply quotes) and the parts to send again when retrying or editing. Pure, so it
 * is tested alone.
 */
import { INPUT_ANSWER_TAG, isHiddenPart, type ActorId, type ChatMessage, type Link, type MessageId, type MessagePart, type ModelCallId, type OutgoingPart, type RunId, type TurnId } from '@harness/core';

/** A mention in a message. */
export type MentionPart = Extract<MessagePart, { type: 'mention' }>;

/** An input form's answers, as a message carries them. */
export type InputAnswerPart = Extract<MessagePart, { type: 'input-answer' }>;

export { isHiddenPart };

/**
 * Whether a person's message shows nothing: every part is hidden (a form's answers, what the hub added), so it has no
 * words and no files. Such a message is left out of the thread unless the chat is in debug mode.
 */
export function isHiddenMessage(message: Pick<ChatMessage, 'role' | 'parts'>): boolean {
  return message.role === 'user' && message.parts.every(isHiddenPart);
}

/** The answers sent to each input form, by the run that asked (the first answer wins). */
export function inputAnswers(messages: readonly ChatMessage[]): ReadonlyMap<RunId, InputAnswerPart> {
  const answers = new Map<RunId, InputAnswerPart>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'input-answer' && !answers.has(part.run)) { answers.set(part.run, part); }
    }
  }
  return answers;
}

/** An input form's answers as the model reads them (`<input-answer title="…">…</input-answer>`). */
export function inputAnswerText(part: Pick<InputAnswerPart, 'title' | 'text'>): string {
  return `<${INPUT_ANSWER_TAG} title="${part.title.replaceAll('"', '&quot;')}">${part.text}</${INPUT_ANSWER_TAG}>`;
}

/** What the thread shows besides the plain messages. */
export interface ThreadOptions {
  /** Show the messages the chat hides (debug mode). */
  readonly debug?: boolean;
  readonly locale?: string;
}

/** One row of the thread. */
export type ThreadItem =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  /**
   * A person's message. `carried` are the messages that carry what its `!` runs attached (the hub posts them by the
   * system that ran the fn); they show under the message's own run cards, not as an answer of their own.
   */
  | {
    readonly kind: 'user'; readonly key: string; readonly message: ChatMessage; readonly mine: boolean; readonly carried: readonly ChatMessage[];
    /** Only parts the chat hides (shown in debug mode alone). */
    readonly hidden: boolean;
  }
  /**
   * The model re-read the whole chat for the answer below (no prompt cache hit, where earlier calls had one): a wavy
   * rule across the thread with the time of the call behind it.
   */
  | { readonly kind: 'cache-miss'; readonly key: string; readonly call: ModelCallId; readonly at: number }
  | { readonly kind: 'answer'; readonly key: string; readonly turn: TurnId; readonly author: ActorId; readonly messages: readonly ChatMessage[]; readonly streaming: boolean; readonly failed: boolean }
  /** A note; an undo note carries the messages of the turn it undid, which the thread no longer shows in place. */
  | { readonly kind: 'note'; readonly key: string; readonly message: ChatMessage; readonly undone: readonly ChatMessage[] };

const DAY = 86_400_000;

/** The start of a timestamp's day, in the reader's time zone. */
export function dayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A day's name: "Today", "Yesterday", or its date ("Mon 3 Nov", with the year when it's another one). */
export function dayLabel(at: number, now: number, locale?: string): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY);
  if (days === 0) { return 'Today'; }
  if (days === 1) { return 'Yesterday'; }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** The turns that were undone: the hub posts a note in the turn it undid, and only then. */
export function undoneTurns(messages: readonly ChatMessage[]): ReadonlySet<TurnId> {
  return new Set(messages.filter((m) => m.role === 'note').map((m) => m.turn));
}

/**
 * The messages that carry what a person's `!` runs attached, by the message that started the runs: an assistant
 * message replying to a message with an invocation (no agent answers those).
 */
export function invocationCarriers(messages: readonly ChatMessage[]): ReadonlyMap<MessageId, readonly ChatMessage[]> {
  const invoked = new Set(messages.filter((m) => m.role === 'user' && m.parts.some((part) => part.type === 'invocation')).map((m) => m.id));
  const carriers = new Map<MessageId, ChatMessage[]>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.replyTo === undefined || !invoked.has(message.replyTo)) { continue; }
    carriers.set(message.replyTo, [...(carriers.get(message.replyTo) ?? []), message]);
  }
  return carriers;
}

/**
 * Group messages (oldest first) into the thread's rows. The question and answer of an undone turn leave the thread;
 * its note keeps them, so a retry or an edit reads as the question asked once. What a `!` run attached rides with the
 * message that ran it (`carried`), so each run shows once, under the person who ran it.
 */
export function threadItems(messages: readonly ChatMessage[], me: ActorId | undefined, now: number, options: ThreadOptions = {}): ThreadItem[] {
  const { debug = false, locale } = options;
  const items: ThreadItem[] = [];
  const undone = undoneTurns(messages);
  const carriers = invocationCarriers(messages);
  const carried = new Set([...carriers.values()].flat().map((m) => m.id));
  const hidden = new Map<TurnId, ChatMessage[]>();
  let day: number | undefined;
  let answer: { turn: TurnId; author: ActorId; messages: ChatMessage[]; at: number } | undefined;
  const closeAnswer = (): void => {
    if (answer === undefined) { return; }
    const first = answer.messages[0];
    const missed = answer.messages.find((m) => m.cacheMiss !== undefined)?.cacheMiss;
    if (missed !== undefined && first !== undefined) { items.push({ kind: 'cache-miss', key: `c-${first.id}`, call: missed.call, at: missed.at }); }
    if (first !== undefined) {
      items.push({
        kind: 'answer', key: `a-${first.id}`, turn: answer.turn, author: answer.author, messages: answer.messages,
        streaming: answer.messages.some((m) => m.status === 'streaming'), failed: answer.messages.at(-1)?.status === 'failed',
      });
    }
    answer = undefined;
  };
  for (const message of messages) {
    if (message.role !== 'note' && undone.has(message.turn)) {
      hidden.set(message.turn, [...(hidden.get(message.turn) ?? []), message]);
      continue;
    }
    const hiddenMessage = isHiddenMessage(message);
    if (hiddenMessage && !debug) { continue; }
    const start = dayStart(message.createdAt);
    if (start !== day) {
      closeAnswer();
      day = start;
      items.push({ kind: 'day', key: `d-${start}`, label: dayLabel(message.createdAt, now, locale) });
    }
    if (carried.has(message.id)) { continue; }
    if (message.role === 'assistant') {
      if (answer !== undefined && answer.turn === message.turn && answer.author === message.author) {
        answer.messages.push(message);
        continue;
      }
      closeAnswer();
      answer = { turn: message.turn, author: message.author, messages: [message], at: message.createdAt };
      continue;
    }
    closeAnswer();
    items.push(message.role === 'user'
      ? { kind: 'user', key: `u-${message.id}`, message, mine: message.author === me, carried: carriers.get(message.id) ?? [], hidden: hiddenMessage }
      : { kind: 'note', key: `n-${message.id}`, message, undone: hidden.get(message.turn) ?? [] });
  }
  closeAnswer();
  return items;
}

/** A message as plain text: its words, `@label` for mentions, `/context args` for commands. Added parts are left out. */
export function messageText(parts: readonly MessagePart[]): string {
  return parts.map((part) => {
    switch (part.type) {
      case 'text': return part.text;
      case 'mention': return `@${part.label}`;
      case 'command': return [`/${part.context}`, ...Object.values(part.args)].join(' ');
      case 'file': return `[${part.name}]`;
      case 'link': return 'title' in part.link && part.link.title !== undefined ? part.link.title : '';
      case 'attachment': return part.title;
      case 'reasoning': case 'invocation': case 'call': case 'extra': case 'hook': case 'input-answer': return '';
    }
  }).filter((text) => text !== '').join(' ').replace(/ {2,}/g, ' ').trim();
}

/** The parts of a message a person sent, as they would send them again (for Retry and Edit). */
export function resendParts(parts: readonly MessagePart[]): OutgoingPart[] {
  const out: OutgoingPart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text': out.push({ type: 'text', text: part.text }); break;
      case 'mention': out.push({ type: 'mention', provider: part.provider, label: part.label, target: part.target }); break;
      case 'command': out.push({ type: 'command', context: part.context, args: part.args }); break;
      case 'file': out.push({ type: 'file', ref: part.ref, name: part.name }); break;
      // the rest are added by the hub or the agent, never sent by a person
      // a form's answers belong to the run that asked, which a resend doesn't repeat
      case 'reasoning': case 'invocation': case 'call': case 'extra': case 'hook': case 'input-answer': case 'attachment': case 'link': break;
    }
  }
  return out;
}

/** Insert or replace a message in a list kept oldest first (by time, then id). */
export function upsertMessage(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const without = messages.filter((m) => m.id !== message.id);
  const at = without.findIndex((m) => m.createdAt > message.createdAt || (m.createdAt === message.createdAt && m.id > message.id));
  return at === -1 ? [...without, message] : [...without.slice(0, at), message, ...without.slice(at)];
}

/** Add streamed text to a message: to its last text part, or a new one. */
export function appendToken(message: ChatMessage, text: string): ChatMessage {
  const last = message.parts.at(-1);
  const parts: MessagePart[] = last?.type === 'text'
    ? [...message.parts.slice(0, -1), { type: 'text', text: last.text + text }]
    : [...message.parts, { type: 'text', text }];
  return { ...message, parts, status: 'streaming' };
}

/** Merge an older page (newest first, as the hub sends it) in front of the messages held, dropping ones already held. */
export function prependPage(messages: readonly ChatMessage[], page: readonly ChatMessage[]): ChatMessage[] {
  const known = new Set<MessageId>(messages.map((m) => m.id));
  const older = page.filter((m) => !known.has(m.id)).reverse();
  return [...older, ...messages];
}

/** The text a user message shows, its parts split into what the person wrote and what was added for the model. */
export function splitParts(parts: readonly MessagePart[]): { readonly shown: MessagePart[]; readonly added: MessagePart[] } {
  const shown: MessagePart[] = [];
  const added: MessagePart[] = [];
  for (const part of parts) {
    if (isHiddenPart(part)) { added.push(part); } else { shown.push(part); }
  }
  return { shown, added };
}

/**
 * What an answer message holds, in the order the model produced it: reasoning, words, and the fns it called (a
 * `runs` segment holds the runs of calls made together). Kept live while the message streams, so the thread shows
 * each thing where it happened.
 */
export type AnswerSegment =
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'runs'; readonly runs: readonly RunId[] };

/** Add to an answer's segments: more of the same kind joins the last segment, anything else starts a new one. */
export function addSegment(segments: readonly AnswerSegment[], next: AnswerSegment): AnswerSegment[] {
  const last = segments.at(-1);
  if (last === undefined || last.kind !== next.kind) { return [...segments, next]; }
  if (last.kind === 'runs' && next.kind === 'runs') {
    return [...segments.slice(0, -1), { kind: 'runs', runs: [...last.runs, ...next.runs.filter((run) => !last.runs.includes(run))] }];
  }
  if (last.kind !== 'runs' && next.kind !== 'runs') { return [...segments.slice(0, -1), { kind: last.kind, text: last.text + next.text }]; }
  return [...segments, next];
}

/**
 * An answer's live segments once it is finished: the words it ended with that never streamed (a "Cancelled.", or
 * the rest of a reply the stream cut short) are added at the end, so the stored reply always shows.
 */
export function settleSegments(live: readonly AnswerSegment[], message: Pick<ChatMessage, 'parts'>): AnswerSegment[] {
  const said = live.map((segment) => (segment.kind === 'text' ? segment.text : '')).join('');
  const final = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  if (final === '' || said.endsWith(final)) { return [...live]; }
  return addSegment(live, { kind: 'text', text: final.startsWith(said) ? final.slice(said.length) : final });
}

/** The runs an answer's segments place. */
function placedRuns(segments: readonly AnswerSegment[]): ReadonlySet<RunId> {
  return new Set(segments.flatMap((segment) => (segment.kind === 'runs' ? segment.runs : [])));
}

/**
 * A stored answer message's segments, in the order its parts keep: reasoning and words as they are, a `call` part as
 * the run it started. Runs the parts don't place came before the words (an answer's reply follows the fns it
 * ran), so they go after the reasoning that opens the message.
 */
export function storedSegments(message: Pick<ChatMessage, 'parts' | 'runs'>): AnswerSegment[] {
  let segments: AnswerSegment[] = [];
  for (const part of message.parts) {
    if (part.type === 'reasoning' || part.type === 'text') { segments = addSegment(segments, { kind: part.type, text: part.text }); }
    if (part.type === 'call') { segments = addSegment(segments, { kind: 'runs', runs: [part.run] }); }
  }
  return withRuns(segments, message.runs);
}

/** Segments with every one of `runs`: those not placed yet go after the opening reasoning, before anything else. */
export function withRuns(segments: readonly AnswerSegment[], runs: readonly RunId[]): AnswerSegment[] {
  const placed = placedRuns(segments);
  const missing = runs.filter((run) => !placed.has(run));
  if (missing.length === 0) { return [...segments]; }
  const at = segments.findIndex((segment) => segment.kind !== 'reasoning');
  const cut = at === -1 ? segments.length : at;
  return [...segments.slice(0, cut), ...segments.slice(cut).reduce<AnswerSegment[]>(addSegment, [{ kind: 'runs', runs: missing }])];
}

/** One piece of an answer, in the order it happened. */
export type AnswerPiece =
  | { readonly kind: 'reasoning'; readonly key: string; readonly text: string }
  | { readonly kind: 'text'; readonly key: string; readonly text: string }
  | { readonly kind: 'runs'; readonly key: string; readonly runs: readonly RunId[] }
  | { readonly kind: 'attachment'; readonly key: string; readonly part: Extract<MessagePart, { type: 'attachment' }> }
  | { readonly kind: 'link'; readonly key: string; readonly link: Link };

/**
 * An answer message's pieces in the order they happened: its segments (the live ones the thread saw stream, else
 * the stored ones), with what its runs attached right after the last of its runs (before the words when it ran none).
 */
export function answerPieces(message: Pick<ChatMessage, 'parts' | 'runs'>, live?: readonly AnswerSegment[]): AnswerPiece[] {
  const segments = live === undefined ? storedSegments(message) : withRuns(live, message.runs);
  const pieces: AnswerPiece[] = segments.map((segment, i) => (segment.kind === 'runs'
    ? { kind: 'runs', key: `s${i}`, runs: segment.runs }
    : { kind: segment.kind, key: `s${i}`, text: segment.text }));
  const extras = message.parts.flatMap((part, i): AnswerPiece[] => {
    if (part.type === 'attachment') { return [{ kind: 'attachment', key: `a${i}`, part }]; }
    if (part.type === 'link') { return [{ kind: 'link', key: `l${i}`, link: part.link }]; }
    return [];
  });
  const lastRuns = pieces.findLastIndex((piece) => piece.kind === 'runs');
  const firstText = pieces.findIndex((piece) => piece.kind === 'text');
  const at = lastRuns !== -1 ? lastRuns + 1 : firstText !== -1 ? firstText : pieces.length;
  return [...pieces.slice(0, at), ...extras, ...pieces.slice(at)];
}
