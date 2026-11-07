/**
 * The thread as it is drawn: messages in order, grouped into rows. All the assistant messages of one turn by one
 * agent become one answer (one avatar, one time), days get separators, and notes sit between them. Also the plain
 * text of a message (for copying and reply quotes) and the parts to send again when retrying or editing. Pure, so it
 * is tested alone.
 */
import type { ActorId, ChatMessage, MessageId, MessagePart, OutgoingPart, TurnId } from '@harness/core';

/** A mention in a message. */
export type MentionPart = Extract<MessagePart, { type: 'mention' }>;

/** One row of the thread. */
export type ThreadItem =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'user'; readonly key: string; readonly message: ChatMessage; readonly mine: boolean }
  | { readonly kind: 'answer'; readonly key: string; readonly turn: TurnId; readonly author: ActorId; readonly messages: readonly ChatMessage[]; readonly streaming: boolean; readonly failed: boolean }
  | { readonly kind: 'note'; readonly key: string; readonly message: ChatMessage };

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

/** Group messages (oldest first) into the thread's rows. */
export function threadItems(messages: readonly ChatMessage[], me: ActorId | undefined, now: number, locale?: string): ThreadItem[] {
  const items: ThreadItem[] = [];
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
    const start = dayStart(message.createdAt);
    if (start !== day) {
      closeAnswer();
      day = start;
      items.push({ kind: 'day', key: `d-${start}`, label: dayLabel(message.createdAt, now, locale) });
    }
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
      ? { kind: 'user', key: `u-${message.id}`, message, mine: message.author === me }
      : { kind: 'note', key: `n-${message.id}`, message });
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
      case 'invocation': case 'extra': case 'hook': return '';
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
      default: break;
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
