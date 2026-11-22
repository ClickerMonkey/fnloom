/**
 * The stream guard: a tool call whose arguments run blank is stopped there and finished with a note the model reads
 * as that call's error; one cut off by the output limit is finished the same way instead of reaching aeye as
 * `length`; blank text ends the answer; and a healthy stream passes unchanged.
 */
import type { Chunk, Request, Response, Streamer, ToolCall } from '@aeye/core';
import { describe, expect, it } from 'vitest';
import { BlankRun, guardStream, STOPPED_HEAD, stoppedArguments } from './stream-guard.ts';

const REQUEST: Request = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 };

/** A streamer over fixed chunks that says whether it was left early. */
function scripted(chunks: Chunk[]): { streamer: Streamer<object, object>; pulled: () => number; closedEarly: () => boolean } {
  let pulled = 0;
  let finished = false;
  let closed = false;
  const streamer: Streamer<object, object> = async function* fake(): AsyncGenerator<Chunk, Response> {
    try {
      for (const chunk of chunks) { pulled += 1; yield chunk; }
      finished = true;
      return { content: '', finishReason: 'stop', model: 'fake' };
    } finally {
      closed = !finished;
    }
  };
  return { streamer, pulled: () => pulled, closedEarly: () => closed };
}

async function collect(streamer: Streamer<object, object>, request: Request = REQUEST): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for await (const chunk of streamer(request, {}, {})) out.push(chunk);
  return out;
}

/** A provider's growing call: its whole arguments so far in each chunk (as aeye's providers stream them; a copy per chunk here, as the chunks are made up front). */
function growing(id: string, name: string, pieces: string[], end: 'finish' | 'length' | 'none' = 'finish'): Chunk[] {
  const call: ToolCall = { id, name, arguments: '' };
  const chunks: Chunk[] = [];
  pieces.forEach((piece, i) => {
    call.arguments += piece;
    chunks.push(i === 0 ? { toolCallNamed: { ...call } } : { toolCallArguments: { ...call } });
  });
  if (end === 'finish') chunks.push({ toolCall: { ...call } }, { finishReason: 'tool_calls' });
  if (end === 'length') chunks.push({ finishReason: 'length' }, { toolCall: { ...call } }, { usage: { text: { output: 500 } } });
  return chunks;
}

describe('BlankRun', () => {
  it('counts blanks and their JSON escapes at the end of a growing text', () => {
    const run = new BlankRun();
    expect(run.read('{"a": "x  ')).toBe(2);
    expect(run.read('{"a": "x  \\n\\n\\t')).toBe(5);
    expect(run.read('{"a": "x  \\n\\n\\t y')).toBe(0);
    expect(run.read('{"a": "x  \\n\\n\\t y\\"   ')).toBe(3);
    expect(new BlankRun().read('  \n', true)).toBe(3);
  });
});

describe('guardStream', () => {
  it('passes a healthy stream through unchanged', async () => {
    const chunks = [{ content: 'Hello  ' }, { content: 'there.' }, ...growing('c1', 'save', ['{"a":', ' 1}'])];
    const { streamer } = scripted(chunks);
    expect(await collect(guardStream(streamer, { blankRun: 100 }))).toEqual(chunks);
  });

  it('stops a tool call whose arguments run blank and finishes it with a note', async () => {
    const pieces = ['{"draft": {"name": "x",', ...Array.from({ length: 40 }, () => ' '.repeat(10)), '"never": 1}}'];
    const inner = scripted(growing('c1', 'set', pieces));
    const out = await collect(guardStream(inner.streamer, { blankRun: 200 }));
    // stopped after 200 blanks (20 pieces), long before the provider's 40, and the provider's stream was left
    expect(inner.pulled()).toBe(21);
    expect(inner.closedEarly()).toBe(true);
    const last = out.at(-1);
    expect(last?.finishReason).toBe('tool_calls');
    expect(last?.toolCall?.id).toBe('c1');
    expect(last?.toolCall?.arguments.startsWith('Stopped by the hub: these arguments ran into 200 blank characters')).toBe(true);
    expect(last?.toolCall?.arguments).toContain('It began: {"draft": {"name": "x",');
    // the stopped arguments are short (the note and a head), and not JSON: the call fails back to the model
    expect(last?.toolCall?.arguments.length).toBeLessThan(STOPPED_HEAD + 400);
    expect(() => { JSON.parse(last?.toolCall?.arguments ?? ''); }).toThrow();
  });

  it('counts escaped newlines inside a string as blank', async () => {
    const inner = scripted(growing('c1', 'set', ['{"sql": "select', ...Array.from({ length: 30 }, () => '\\n'.repeat(10))]));
    const out = await collect(guardStream(inner.streamer, { blankRun: 100 }));
    expect(out.at(-1)?.toolCall?.arguments).toMatch(/^Stopped by the hub/);
  });

  it('finishes a call the output limit cut off instead of passing on length', async () => {
    const inner = scripted(growing('c1', 'set', ['{"draft": {"rows": [1, 2,', ' 3, 4'], 'length'));
    const out = await collect(guardStream(inner.streamer, { blankRun: 100 }));
    expect(out.some((chunk) => chunk.finishReason === 'length')).toBe(false);
    expect(out.find((chunk) => chunk.finishReason !== undefined)?.finishReason).toBe('tool_calls');
    const finished = out.filter((chunk) => chunk.toolCall !== undefined);
    // one finish for the call: the guard's (the provider's own late finish with the cut arguments is dropped)
    expect(finished).toHaveLength(1);
    expect(finished[0]?.toolCall?.arguments).toBe(stoppedArguments('length', '{"draft": {"rows": [1, 2, 3, 4', { blankRun: 100, maxTokens: 500 }));
    expect(finished[0]?.toolCall?.arguments).toContain('output limit (500 tokens)');
    // what came after (the usage) still goes out
    expect(out.at(-1)?.usage).toEqual({ text: { output: 500 } });
  });

  it('leaves length alone when no call is open (a text answer that ran out)', async () => {
    const chunks: Chunk[] = [{ content: 'A long answer' }, { finishReason: 'length' }];
    const { streamer } = scripted(chunks);
    expect(await collect(guardStream(streamer, { blankRun: 100 }))).toEqual(chunks);
  });

  it('ends an answer whose text runs blank', async () => {
    const inner = scripted([{ content: 'Here it is.' }, ...Array.from({ length: 30 }, () => ({ content: '\n'.repeat(10) })), { content: 'never' }]);
    const out = await collect(guardStream(inner.streamer, { blankRun: 100 }));
    expect(inner.closedEarly()).toBe(true);
    expect(out.at(-1)?.finishReason).toBe('stop');
    expect(out.map((chunk) => chunk.content ?? '').join('')).not.toContain('never');
  });
});
