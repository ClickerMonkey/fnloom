/**
 * The thread as it is drawn: messages in order, grouped into rows. All the assistant messages of one turn by one
 * agent become one answer (one avatar, one time), days get separators, and notes sit between them. Also the plain
 * text of a message (for copying and reply quotes) and the parts to send again when retrying or editing. Pure, so it
 * is tested alone.
 */
import type { ActorId, ChatMessage, Link, MessageId, MessagePart, OutgoingPart, RunId, TurnId } from '@harness/core';

/** A mention in a message. */
export type MentionPart = Extract<MessagePart, { type: 'mention' }>;

/** One row of the thread. */
export type ThreadItem =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  /**
   * A person's message. `carried` are the messages that carry what its `!` runs attached (the hub posts them by the
   * system that ran the fn); they show under the message's own run cards, not as an answer of their own.
   */
  | { readonly kind: 'user'; readonly key: string; readonly message: ChatMessage; readonly mine: boolean; readonly carried: readonly ChatMessage[] }
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
export function threadItems(messages: readonly ChatMessage[], me: ActorId | undefined, now: number, locale?: string): ThreadItem[] {
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
      ? { kind: 'user', key: `u-${message.id}`, message, mine: message.author === me, carried: carriers.get(message.id) ?? [] }
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
      case 'reasoning': case 'invocation': case 'extra': case 'hook': case 'input-answer': return '';
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
      case 'reasoning': case 'invocation': case 'extra': case 'hook': case 'attachment': case 'link': break;
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
    if (part.type === 'extra' || part.type === 'hook') { added.push(part); } else { shown.push(part); }
  }
  return { shown, added };
}

/** One piece of an answer, in the order it happened. */
export type AnswerPiece =
  | { readonly kind: 'text'; readonly key: string; readonly text: string }
  | { readonly kind: 'runs'; readonly key: string; readonly runs: readonly RunId[] }
  | { readonly kind: 'attachment'; readonly key: string; readonly part: Extract<MessagePart, { type: 'attachment' }> }
  | { readonly kind: 'link'; readonly key: string; readonly link: Link };

/**
 * An answer message's pieces in the order they happened. A finished message holds the agent's final reply, which
 * came after every fn it ran, so its runs come first, then what they attached, then the reply. While it streams, each
 * run sits where the text had got to when the run appeared (`marks`, text offsets the thread saw live); a run the
 * thread didn't see appear sits before the text.
 */
export function answerPieces(message: Pick<ChatMessage, 'parts' | 'runs' | 'status'>, marks: ReadonlyMap<RunId, number>): AnswerPiece[] {
  const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  const extras = message.parts.flatMap((part, i): AnswerPiece[] => {
    if (part.type === 'attachment') { return [{ kind: 'attachment', key: `a${i}`, part }]; }
    if (part.type === 'link') { return [{ kind: 'link', key: `l${i}`, link: part.link }]; }
    return [];
  });
  const live = message.status === 'streaming';
  const at = (run: RunId): number => (live ? Math.min(marks.get(run) ?? 0, text.length) : 0);
  const groups = new Map<number, RunId[]>();
  for (const run of message.runs) { groups.set(at(run), [...(groups.get(at(run)) ?? []), run]); }
  const out: AnswerPiece[] = [];
  let from = 0;
  for (const offset of [...groups.keys()].sort((a, b) => a - b)) {
    if (offset > from) { out.push({ kind: 'text', key: `t${from}`, text: text.slice(from, offset) }); }
    out.push({ kind: 'runs', key: `r${offset}`, runs: groups.get(offset) ?? [] });
    from = offset;
  }
  out.push(...extras);
  if (text.length > from) { out.push({ kind: 'text', key: `t${from}`, text: text.slice(from) }); }
  return out;
}

/** How long a message's text is: where a run appearing now would sit in it. */
export function messageTextLength(message: Pick<ChatMessage, 'parts'>): number {
  return message.parts.reduce((length, part) => length + (part.type === 'text' ? part.text.length : 0), 0);
}

/** The reasoning an answer message kept (its `reasoning` parts), '' when it has none. */
export function storedReasoning(message: Pick<ChatMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'reasoning' ? part.text : '')).join('');
}
