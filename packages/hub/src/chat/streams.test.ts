/** The order an answer streams in: reasoning, text and fn calls kept as they came, mid-stream and once finished. */
import { ActorId, MessageId, QualifiedName, RunId, SessionId, TurnId, type ChatMessage } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { finishedParts, StreamBuffer } from './streams.ts';

const MESSAGE = MessageId.parse('msg_1');
const bash = (n: number) => ({ run: RunId.parse(`run_${n}`), fn: QualifiedName.parse('fs/bash') });

describe('a streamed answer', () => {
  it('keeps reasoning, text and calls in the order the model made them, across iterations', () => {
    const buffer = new StreamBuffer();
    buffer.open(MESSAGE, SessionId.parse('ses_1'));
    buffer.append(MESSAGE, { reasoning: 'I should ' });
    buffer.append(MESSAGE, { reasoning: 'look.' });
    buffer.append(MESSAGE, { text: 'Checking.' });
    expect(buffer.call(MESSAGE, [bash(1), bash(2)])).toBe(2);
    expect(buffer.call(MESSAGE, [bash(1)])).toBe(0);
    buffer.append(MESSAGE, { reasoning: 'Both ran.' });
    buffer.append(MESSAGE, { text: 'Done: ' });
    buffer.append(MESSAGE, { text: 'two files.' });
    const stored: ChatMessage = {
      id: MESSAGE, session: SessionId.parse('ses_1'), turn: TurnId.parse('trn_1'), author: ActorId.parse('act_a'), role: 'assistant', parts: [], runs: [], status: 'streaming', replyAll: false, answerers: [], createdAt: 0,
    };
    const shown = buffer.overlay(stored).parts;
    expect(shown.map((p) => p.type)).toEqual(['reasoning', 'text', 'call', 'call', 'reasoning', 'text']);
    expect(shown[5]).toEqual({ type: 'text', text: 'Done: two files.' });
    const streamed = buffer.close(MESSAGE)?.parts ?? [];
    // the final answer stands for the text after the last call; text between calls stays
    expect(finishedParts(streamed, [{ type: 'text', text: 'Done: two files!' }])).toEqual([
      { type: 'reasoning', text: 'I should look.' }, { type: 'text', text: 'Checking.' }, { type: 'call', ...bash(1) }, { type: 'call', ...bash(2) },
      { type: 'reasoning', text: 'Both ran.' }, { type: 'text', text: 'Done: two files!' },
    ]);
    expect(buffer.call(MESSAGE, [bash(3)])).toBe(0);
  });
});
