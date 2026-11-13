import { PromptSuspend, type Request } from '@aeye/core';
import { fn, g } from '@harness/sdk';
import type { LlmMessage, TableReading } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Channel } from './channel.ts';
import { localTime, timeInfo } from './time.ts';
import { fnModeTool } from '../contextor/modes.ts';
import { CatalogFnViews } from '../contextor/views.ts';
import { agentTools, PendingCalls } from './tools.ts';
import { TestCatalog } from './testing.ts';
import {
  chunkFromWire, chunkToWire, descriptorsOf, isObjectSchema, messageFromWire, messageToWire, replyText, requestFromWire, requestToWire, responseToWire, tokensOf,
  toolName, usageToWire,
} from './wire.ts';

/** A run a person watches, reading five rows of a table. */
const SHOWN: TableReading = { rows: 5, watched: true };

describe('tool names', () => {
  it('fit what providers allow', () => {
    expect(toolName('fs/read')).toBe('fs__read');
    expect(toolName('fs/Entry.reveal')).toBe('fs__Entry--reveal');
    expect(toolName(`fs/${'x'.repeat(80)}`)).toHaveLength(64);
  });
});

describe('messages', () => {
  it('round-trip through the saved form', () => {
    const saved: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', content: 'look' }, { type: 'image', content: 'https://x/y.png', format: 'png' }] },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'fs__read', arguments: '{"path":"a"}' }] },
      { role: 'tool', content: 'text', toolCallId: '1' },
    ];
    expect(saved.map(messageFromWire).map(messageToWire)).toEqual(saved);
  });

  it('saves bytes as data URLs and URLs as their address', () => {
    expect(messageToWire({ role: 'user', content: [{ type: 'image', content: new Uint8Array([1, 2]), format: 'png' }] }).content).toEqual([{ type: 'image', content: 'data:image/png;base64,AQI=', format: 'png' }]);
    expect(messageToWire({ role: 'user', content: [{ type: 'file', content: new URL('https://a/b.pdf') }] }).content).toEqual([{ type: 'file', content: 'https://a/b.pdf' }]);
  });

  it('writes tool replies as aeye does', () => {
    expect(replyText('plain', SHOWN)).toBe('plain');
    expect(replyText({ a: [1] }, SHOWN)).toBe('{"a":[1]}');
  });

  it('gives a widget proposal as its preview\'s summary and first rows, waiting for the person\'s Save', () => {
    const visual = { visual: 'table', style: 'table', bind: {} };
    const table = { columns: [{ name: 'n', kind: 'integer', nullable: false }], rows: Array.from({ length: 50 }, (_, i) => [i]), offset: 0, truncated: false, sort: [] };
    const preview = {
      title: 'Numbers', table, facts: { columns: [], rows: 50, whole: true }, source: { fn: 'shop/numbers', run: 'run_1', args: {} }, visuals: [visual],
      problems: [], controls: [], presets: [], actions: [], readOnly: false, summary: 'Table of n, 50 rows',
    };
    const spec = { title: 'Numbers', source: 'shop/numbers', visuals: [visual], args: {}, presets: [] };
    const reply: unknown = JSON.parse(replyText({ name: 'numbers', description: 'The numbers.', spec, preview, show: true }, { rows: 3, watched: true }));
    expect(reply).toEqual({
      proposed: 'numbers: The numbers.', saved: 'Proposed, not saved: the person sees the preview and presses Save to keep it.',
      summary: 'Table of n, 50 rows, shown to the person', columns: ['n'], rows: [[0], [1], [2]], more: 47,
    });
  });

  it('lists the changed files of a command for the model without their diffs, which the run keeps', () => {
    const result = {
      exitCode: 0, stdout: 'ok', stderr: '',
      changes: {
        source: 'git', cwd: '/repo', ignored: 2, truncated: false,
        files: [
          { path: 'src/a.ts', root: 'repo', status: 'modified', diff: '@@ -1 +1 @@\n-a\n+b\n', added: 1, removed: 1, certain: true },
          { path: 'logo.png', root: 'repo', status: 'added', noDiff: 'binary', certain: false },
        ],
      },
    };
    const text = replyText(result, SHOWN);
    expect(text).toBe([
      '{"exitCode":0,"stdout":"ok","stderr":""}',
      'Changed files (git):',
      '- modified repo:src/a.ts (+1 -1)',
      '- added repo:logo.png, no diff: binary, maybe the change of another call',
      '(2 ignored by git)',
    ].join('\n'));
    expect(text).not.toContain('@@');
    expect(replyText({ changes: 'not a change set' }, SHOWN)).toBe('{"changes":"not a change set"}');
  });
});

describe('requests', () => {
  const request: Request = {
    messages: [{ role: 'system', content: 'be kind' }, { role: 'user', content: 'hi' }],
    temperature: 0.2,
    stop: 'END',
    tools: [{ name: 'fs__read', description: 'Read.', parameters: z.object({ path: z.string() }), strict: 1 }],
    toolChoice: { allowed: ['fs__read'], required: true },
    responseFormat: { type: z.object({ answer: z.string() }), strict: false },
  };

  it('save tool and output schemas as JSON schema', () => {
    const wire = requestToWire(request);
    expect(wire.stop).toEqual(['END']);
    expect(wire.toolChoice).toBe('required');
    expect(wire.tools?.[0]).toMatchObject({ name: 'fs__read', strict: 1, parameters: { type: 'object', properties: { path: { type: 'string' } } } });
    expect(wire.responseFormat).toMatchObject({ strict: false, schema: { type: 'object' } });
  });

  it('come back from the wire with working zod schemas', () => {
    const rebuilt = requestFromWire(requestToWire(request));
    expect(rebuilt.tools?.[0]?.parameters.safeParse({ path: 'a' }).success).toBe(true);
    expect(rebuilt.tools?.[0]?.parameters.safeParse({ path: 1 }).success).toBe(false);
    const format = rebuilt.responseFormat;
    if (format === undefined || typeof format === 'string') throw new Error('expected a schema');
    expect(format.type.safeParse({ answer: 'x' }).success).toBe(true);
  });

  it('refuse tool schemas that are not objects', () => {
    expect(() => requestFromWire({ messages: [], tools: [{ name: 't', parameters: { type: 'string' } }] })).toThrow(/object/);
  });

  it('report the descriptors a provider chose', () => {
    const built: Request = { messages: [], tools: [{ name: 'a', parameters: z.object({}), descriptor: 'openai' }, { name: 'b', parameters: z.object({}) }], responseFormat: { type: z.object({}), strict: true, descriptor: 'openai' } };
    expect(descriptorsOf(built)).toEqual({ tools: { a: 'openai' }, output: 'openai' });
    expect(descriptorsOf({ messages: [] })).toEqual({ tools: {} });
  });
});

describe('chunks and usage', () => {
  it('round-trip chunks', () => {
    const chunk = { content: 'hi', reasoning: 'hmm', toolCall: { id: '1', name: 't', arguments: '{}' }, finishReason: 'tool_calls' as const, usage: { input: 3, output: 4, cached: 1, reasoning: 2 } };
    expect(chunkToWire(chunkFromWire(chunk))).toEqual(chunk);
  });

  it('meter text and reasoning tokens', () => {
    const usage = usageToWire({ text: { input: 10, output: 5 }, reasoning: { output: 2 } });
    expect(usage).toEqual({ input: 10, output: 5, reasoning: 2 });
    expect(tokensOf(usage)).toBe(17);
    expect(usageToWire(undefined)).toEqual({ input: 0, output: 0 });
  });

  it('save a response, marking one cut short', () => {
    expect(responseToWire({ content: 'a', finishReason: 'length', model: 'm', toolCalls: [] }, true)).toEqual({ content: 'a', finishReason: 'length' });
    expect(responseToWire({ content: 'a', finishReason: 'length', model: 'm' }, false).finishReason).toBe('stop');
  });

  it('tell object schemas apart, across zod copies', () => {
    expect(isObjectSchema(z.object({}))).toBe(true);
    expect(isObjectSchema(z.string())).toBe(false);
    expect(isObjectSchema(g.obj({ a: g.text() }).toValueSchema())).toBe(true);
  });
});

describe('fn tools', () => {
  it('record the call and suspend instead of running', async () => {
    const catalog = new TestCatalog();
    const read = catalog.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text() }));
    const scalar = catalog.add('fs', 'odd', fn({ description: 'Odd.', args: g.text(), returns: g.text() }));
    const calls = new PendingCalls();
    const views = new CatalogFnViews(catalog);
    const modeTools = [await views.view(read.name), await views.view(scalar.name)].flatMap((view) => {
      const tool = view === undefined ? undefined : fnModeTool(view);
      return tool === undefined ? [] : [tool, tool];
    });
    const tools = agentTools(modeTools, calls);
    expect(tools.map((t) => t.name)).toEqual(['fs__read']);
    const tool = tools[0];
    if (tool === undefined) throw new Error('no tool');
    expect(() => tool.input.call({ path: 'a' }, [], { toolCallId: 'c1' })).toThrow(PromptSuspend);
    expect(() => tool.input.call({ path: 'a' }, [], {})).toThrow(/tool call id/);
    expect(calls.inOrder(['c1', 'c2'])).toEqual([{ toolCallId: 'c1', name: 'fs__read', args: { path: 'a' } }]);
  });
});

describe('time and channels', () => {
  it('gives the local time with its offset, falling back to UTC for an unknown zone', () => {
    expect(localTime(Date.UTC(2026, 10, 7, 14, 30), 'America/New_York')).toBe('2026-11-07T09:30:00-05:00');
    expect(localTime(Date.UTC(2026, 10, 7, 14, 30), 'UTC')).toBe('2026-11-07T14:30:00+00:00');
    expect(timeInfo(0, 'Nowhere/City').timeZone).toBe('UTC');
  });

  it('streams pushed items to one reader until closed', async () => {
    const channel = new Channel<number>();
    const read = (async () => { const out: number[] = []; for await (const n of channel) out.push(n); return out; })();
    channel.push(1);
    await Promise.resolve();
    channel.push(2);
    channel.close();
    channel.push(3);
    expect(await read).toEqual([1, 2]);
  });
});
