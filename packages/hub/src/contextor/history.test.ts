import type { LlmMessage } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { closeOpenCalls, NO_RESULT_REPLY } from './history.ts';

const user = (content: string): LlmMessage => ({ role: 'user', content });
const calls = (...ids: string[]): LlmMessage => ({ role: 'assistant', content: '', toolCalls: ids.map((id) => ({ id, name: 'fs__read', arguments: '{}' })) });
const reply = (id: string, content = `result ${id}`): LlmMessage => ({ role: 'tool', toolCallId: id, content });
const answer = (content: string): LlmMessage => ({ role: 'assistant', content });
const closed = (id: string): LlmMessage => ({ role: 'tool', toolCallId: id, content: NO_RESULT_REPLY });

/** Every call of an assistant message is answered, contiguously, before the next assistant or user message. */
function wellFormed(transcript: readonly LlmMessage[]): boolean {
  let open = new Set<string>();
  for (const message of transcript) {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !open.delete(message.toolCallId)) return false;
      continue;
    }
    if ((message.role === 'assistant' || message.role === 'user') && open.size > 0) return false;
    if (message.role === 'assistant') open = new Set((message.toolCalls ?? []).map((call) => call.id));
  }
  return open.size === 0;
}

describe('closeOpenCalls', () => {
  it('closes a call left without a reply that later user messages followed (the stuck chat)', () => {
    const transcript = [user('read it'), calls('call_1'), user('hello?'), user('are you there')];
    const healed = closeOpenCalls(transcript);
    expect(healed).toEqual([user('read it'), calls('call_1'), closed('call_1'), user('hello?'), user('are you there')]);
    expect(wellFormed(healed)).toBe(true);
  });

  it('closes the call of two that has no reply, after the reply the other has', () => {
    const transcript = [user('read both'), calls('a', 'b'), reply('a'), user('next')];
    expect(closeOpenCalls(transcript)).toEqual([user('read both'), calls('a', 'b'), reply('a'), closed('b'), user('next')]);
  });

  it('drops a reply that answers no earlier call', () => {
    const transcript = [user('hi'), reply('ghost'), answer('hello')];
    expect(closeOpenCalls(transcript)).toEqual([user('hi'), answer('hello')]);
  });

  it('drops a late reply to a call already closed, and a second reply to one call', () => {
    const transcript = [user('go'), calls('a'), user('wait'), reply('a'), answer('done'), calls('b'), reply('b'), reply('b')];
    const healed = closeOpenCalls(transcript);
    expect(healed).toEqual([user('go'), calls('a'), closed('a'), user('wait'), answer('done'), calls('b'), reply('b')]);
    expect(wellFormed(healed)).toBe(true);
  });

  it('gives a well-formed transcript back as it is', () => {
    const transcript = [user('go'), calls('a', 'b'), reply('b'), reply('a'), answer('done'), user('more'), answer('sure')];
    expect(closeOpenCalls(transcript)).toBe(transcript);
  });

  it('places the closing replies with their own group, before the next assistant message', () => {
    const transcript = [user('go'), calls('a', 'b', 'c'), reply('a'), calls('d'), reply('d'), answer('done')];
    const healed = closeOpenCalls(transcript);
    expect(healed).toEqual([user('go'), calls('a', 'b', 'c'), reply('a'), closed('b'), closed('c'), calls('d'), reply('d'), answer('done')]);
    expect(wellFormed(healed)).toBe(true);
  });

  it('closes calls at the end of the transcript', () => {
    expect(closeOpenCalls([user('go'), calls('a')])).toEqual([user('go'), calls('a'), closed('a')]);
  });
});
