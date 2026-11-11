/**
 * Assistant messages being streamed: their reasoning, text and fn calls so far, in the order the model produced them,
 * so a page of messages read mid-stream shows them as they came, and the finished message keeps that order.
 */
import type { ChatMessage, MessageId, MessagePart, QualifiedName, RunId, SessionId } from '@harness/core';

/** One piece of a streamed answer, in order: a run of reasoning, a run of text, or a fn call. */
export type StreamedPart = Extract<MessagePart, { type: 'reasoning' | 'text' | 'call' }>;

/** What has streamed into one message. */
export interface StreamedText {
  readonly session: SessionId;
  /** The pieces in the order they came; consecutive reasoning or text deltas join one piece. */
  readonly parts: StreamedPart[];
}

/** The pieces streamed into open assistant messages, kept until each is finished. */
export class StreamBuffer {
  readonly #open = new Map<MessageId, StreamedText>();

  open(message: MessageId, session: SessionId): void {
    this.#open.set(message, { session, parts: [] });
  }

  /** Add a delta (reasoning first when a delta carries both); undefined when the message isn't streaming. */
  append(message: MessageId, delta: { text?: string; reasoning?: string }): StreamedText | undefined {
    const streamed = this.#open.get(message);
    if (streamed === undefined) { return undefined; }
    if (delta.reasoning !== undefined && delta.reasoning !== '') { add(streamed.parts, 'reasoning', delta.reasoning); }
    if (delta.text !== undefined && delta.text !== '') { add(streamed.parts, 'text', delta.text); }
    return streamed;
  }

  /** Fn calls the model made, after what it streamed before them; how many were new (none when the message isn't streaming). */
  call(message: MessageId, calls: ReadonlyArray<{ readonly run: RunId; readonly fn: QualifiedName }>): number {
    const streamed = this.#open.get(message);
    if (streamed === undefined) { return 0; }
    let added = 0;
    for (const call of calls) {
      if (streamed.parts.some((part) => part.type === 'call' && part.run === call.run)) { continue; }
      streamed.parts.push({ type: 'call', run: call.run, fn: call.fn });
      added++;
    }
    return added;
  }

  close(message: MessageId): StreamedText | undefined {
    const streamed = this.#open.get(message);
    this.#open.delete(message);
    return streamed;
  }

  /** A stored message with what streamed so far in front of its stored parts, while it is streaming. */
  overlay(message: ChatMessage): ChatMessage {
    const streamed = message.status === 'streaming' ? this.#open.get(message.id) : undefined;
    if (streamed === undefined || streamed.parts.length === 0) { return message; }
    return { ...message, parts: [...streamed.parts, ...message.parts] };
  }
}

/** Add a delta to the last piece when it is of the same type, else start a new piece. */
function add(parts: StreamedPart[], type: 'reasoning' | 'text', text: string): void {
  const last = parts.at(-1);
  if (last !== undefined && last.type === type) { last.text += text; return; }
  parts.push({ type, text });
}

/**
 * The finished message's parts from what streamed and the final answer: the pieces in order, with the answer's text
 * in place of the text after the last call (an answer can differ from its stream: thinking taken out, a structured
 * result written as text). Earlier text, between calls, stays as it streamed.
 */
export function finishedParts(streamed: readonly StreamedPart[], answer: readonly MessagePart[]): MessagePart[] {
  const lastCall = streamed.findLastIndex((part) => part.type === 'call');
  const before = streamed.slice(0, lastCall + 1);
  const after = streamed.slice(lastCall + 1).filter((part) => part.type !== 'text');
  return [...before, ...after, ...answer];
}
