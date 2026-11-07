/** Assistant messages being streamed: their reasoning and text so far, so a page of messages read mid-stream shows them. */
import type { ChatMessage, MessageId, MessagePart, SessionId } from '@harness/core';

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

  /** A stored message with the reasoning and text streamed so far, while it is streaming. */
  overlay(message: ChatMessage): ChatMessage {
    const streamed = message.status === 'streaming' ? this.#open.get(message.id) : undefined;
    if (streamed === undefined || (streamed.text === '' && streamed.reasoning === '')) { return message; }
    const parts: MessagePart[] = [
      ...(streamed.reasoning === '' ? [] : [{ type: 'reasoning' as const, text: streamed.reasoning }]),
      ...message.parts,
      ...(streamed.text === '' ? [] : [{ type: 'text' as const, text: streamed.text }]),
    ];
    return { ...message, parts };
  }
}
