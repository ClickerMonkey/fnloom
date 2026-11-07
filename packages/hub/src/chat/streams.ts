/** Assistant messages being streamed: their text so far, so a page of messages read mid-stream shows it. */
import type { ChatMessage, MessageId, SessionId } from '@harness/core';

/** What has streamed into one message. */
export interface StreamedText {
  readonly session: SessionId;
  text: string;
  reasoning: string;
}

/** The text streamed into open assistant messages, kept until each is finished. */
export class StreamBuffer {
  readonly #open = new Map<MessageId, StreamedText>();

  open(message: MessageId, session: SessionId): void {
    this.#open.set(message, { session, text: '', reasoning: '' });
  }

  /** Add a delta; undefined when the message isn't streaming. */
  append(message: MessageId, delta: { text?: string; reasoning?: string }): StreamedText | undefined {
    const streamed = this.#open.get(message);
    if (streamed === undefined) { return undefined; }
    streamed.text += delta.text ?? '';
    streamed.reasoning += delta.reasoning ?? '';
    return streamed;
  }

  close(message: MessageId): StreamedText | undefined {
    const streamed = this.#open.get(message);
    this.#open.delete(message);
    return streamed;
  }

  /** A stored message with the text streamed so far, while it is streaming. */
  overlay(message: ChatMessage): ChatMessage {
    const streamed = message.status === 'streaming' ? this.#open.get(message.id) : undefined;
    if (streamed === undefined || streamed.text === '') { return message; }
    return { ...message, parts: [...message.parts, { type: 'text', text: streamed.text }] };
  }
}
