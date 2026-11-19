import { fn, g, ginAs } from '@harness/sdk';
import { RESULT_TABLE_INSTRUCTION, RESULT_TABLE_ROUTING, ResultTable, SystemName, type LlmMessage } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { contiguousTail, exchanges, textOf, firstAndLast, isPersonMessage, namedIn, personWords, shorten, shortenResults, summarise } from './history.ts';
import type { FnView } from './index.ts';
import { blockedFnsLine, blockedLine, cardsSection, contextBlock, describedWithEffects, earlierBlock, fnCard, listedLine, tableInstruction, moreContext, moreFns, parseRunBlocks, resultText, RunBlockFilter, splitThinking, ThinkingFilter } from './render.ts';
import { ContextCatalog, contextRecord } from './testing.ts';
import { CatalogFnViews } from './views.ts';

/** A view of `fs/read` with instructions, an example and one named type. */
async function readView(): Promise<FnView> {
  const catalog = new ContextCatalog();
  catalog.addFn('fs/read', fn({
    description: 'Read a text file.', instructions: 'Read whole files under 2000 lines; use lines for longer ones.',
    args: g.obj({ path: g.text(), lines: g.optional(g.obj({ from: g.num(), to: g.num() })) }), returns: g.obj({ text: g.text(), total: g.num() }),
    examples: [{ args: { path: 'docs/harness.md', lines: { from: 1, to: 80 } }, note: 'the first 80 lines' }],
  }));
  const view = await new CatalogFnViews(catalog).view('fs/read');
  if (view === undefined) throw new Error('no view');
  return { ...view, types: new Map([['fs/Entry', 'type fs/Entry = { path: text }']]) };
}

describe('fn cards', () => {
  it('say a fn whose declared return is a table is drawn for the person, with the instruction once', async () => {
    const catalog = new ContextCatalog();
    catalog.addFn('shop/orders', fn({ description: 'Orders as a table.', args: g.obj({}), returns: ginAs(ResultTable) }));
    catalog.addFn('fs/read', fn({ description: 'Read a text file.', args: g.obj({ path: g.text() }), returns: g.text() }));
    const views = new CatalogFnViews(catalog);
    const [orders, read] = [await views.view('shop/orders'), await views.view('fs/read')];
    if (orders === undefined || read === undefined) throw new Error('no view');
    expect(orders.routing).toBe(RESULT_TABLE_ROUTING);
    expect(read.routing).toBeUndefined();
    expect(fnCard(orders, 'listed')).toBe(`<fn name="shop/orders" label="Orders" mode="write" available="yes">\nOrders as a table.\nIt ${RESULT_TABLE_ROUTING}.\n</fn>`);
    expect(describedWithEffects(orders)).toBe(`Orders as a table.
It ${RESULT_TABLE_ROUTING}.`);
    expect(fnCard(read, 'listed')).toBe('<fn name="fs/read" label="Read" mode="write" available="yes">Read a text file.</fn>');
    expect(tableInstruction([read, orders])).toBe(RESULT_TABLE_INSTRUCTION);
    expect(tableInstruction([read])).toBe('');
  });

  it('grow with the detail: a line, then its args and result, then instructions, examples and types', async () => {
    const view = await readView();
    const head = '<fn name="fs/read" label="Read" mode="write" available="yes">';
    expect(fnCard(view, 'listed')).toBe(`${head}Read a text file.</fn>`);
    expect(fnCard(view, 'signature')).toBe([head, 'Read a text file.', `<args>${view.args}</args>`, `<returns>${view.returns}</returns>`, '</fn>'].join('\n'));
    expect(fnCard(view, 'full')).toBe([
      head, 'Read a text file.', `<args>${view.args}</args>`, `<returns>${view.returns}</returns>`,
      '<instructions>Read whole files under 2000 lines; use lines for longer ones.</instructions>',
      '<example note="the first 80 lines">{"path":"docs/harness.md","lines":{"from":1,"to":80}}</example>',
      '<type name="fs/Entry">type fs/Entry = { path: text }</type>',
      '</fn>',
    ].join('\n'));
    // what blocks a fn is on its card, in the hub's words
    expect(fnCard(view, 'listed', new Set(), undefined, 'changed & waits for an admin')).toBe('<fn name="fs/read" label="Read" mode="write" available="no" reason="changed &amp; waits for an admin">Read a text file.</fn>');
  });

  it('say where the rest of the examples are', async () => {
    const catalog = new ContextCatalog();
    catalog.addFn('fs/ls', fn({ description: 'List a folder.', args: g.obj({ path: g.text() }), returns: g.list(g.text()), promptExamples: 1, examples: [{ args: { path: '.' } }, { args: { path: 'src' } }] }));
    const view = await new CatalogFnViews(catalog).view('fs/ls');
    if (view === undefined) throw new Error('no view');
    const full = fnCard(view, 'full');
    expect(full).toContain('<example>{"path":"."}</example>');
    expect(full).not.toContain('"src"');
    expect(full).toContain('<more_examples count="1">Read them with hub/fn_examples {"fn":"fs/ls","query":"what you are about to do"}</more_examples>');
  });

  it('carry what a fn changes and its long-running warning beside its description', async () => {
    const catalog = new ContextCatalog();
    catalog.addFn('fs/read', fn({ description: 'Read a text file.', args: g.obj({ path: g.text() }), returns: g.text() }));
    const views = new CatalogFnViews(catalog, undefined, {
      registry: (names) => Promise.resolve(new Map(names.map((name) => [name, [{ action: 'create' as const, thing: 'fns' as const }]]))),
      notices: (names) => Promise.resolve(new Map(names.map((name) => [name, `${name} usually takes about 3 minutes.`]))),
    });
    const view = await views.view('fs/read');
    if (view === undefined) throw new Error('no view');
    expect(describedWithEffects(view)).toBe(`Read a text file.\n${view.effects ?? ''}\nfs/read usually takes about 3 minutes.`);
    expect(fnCard(view, 'signature').split('\n').slice(2, 4)).toEqual([view.effects, 'fs/read usually takes about 3 minutes.']);
    // a quick fn has no warning
    expect(describedWithEffects(await readView())).toBe('Read a text file.');
  });

  it('print a shared type once per prompt', async () => {
    const view = await readView();
    const shown = new Set<`${string}/${string}`>();
    const both = [fnCard(view, 'full', shown), fnCard(view, 'full', shown)].join('\n');
    expect(both.match(/type fs\/Entry/g)).toHaveLength(1);
    expect(cardsSection([], 'native')).toBe('');
    expect(cardsSection(['a'], 'text')).toContain('<run fn=');
  });

  it('list fns the model can load as listed cards', async () => {
    const view = await readView();
    expect(moreFns([])).toBe('');
    expect(moreFns([view])).toBe('<more_fns>\nLoad any of these with hub/load_fns to use it:\n<fn name="fs/read" label="Read" mode="write" available="yes">Read a text file.</fn>\n</more_fns>');
  });
});

describe('prompt text', () => {
  it('lists, blocks and summaries', () => {
    expect(listedLine('fs/guide', 'How to use fs.\nMore.')).toBe('fs/guide — How to use fs.');
    expect(listedLine('x/y', 'z'.repeat(400)).length).toBeLessThan(170);
    expect(contextBlock({ name: 'fs/guide', detail: 'full', text: 'All of it.' })).toBe('<context key="fs/guide">All of it.</context>');
    expect(contextBlock({ name: 'fs/guide', title: 'Files "guide"', detail: 'signature', text: 'Short.' })).toBe('<context key="fs/guide" title="Files &quot;guide&quot;" detail="summary">Short.</context>');
    // a context's brought fns, each for what it is: in the tools, not this step, or blocked with the hub's reason
    const held = (fn: string) => ({ fn, code: 'held' as const, reason: `${fn} changed and waits for an admin to approve it`, system: SystemName.parse('database') });
    expect(contextBlock({ name: 'database/guide', detail: 'full', text: 'Tables.', fns: {
      added: ['database/list_tables'], waiting: ['database/drop_table'],
      blocked: [held('database/create_table'), held('database/insert_rows'), { fn: 'fs/read', code: 'system-disconnected', reason: 'fs is not connected' }],
    } })).toBe([
      '<context key="database/guide">', 'Tables.',
      '<brought_fns in_tools="yes">In your tools now: database/list_tables</brought_fns>',
      '<brought_fns in_tools="no">Not in your tools this step: database/drop_table</brought_fns>',
      '<brought_fns in_tools="no" available="no">You can\'t use these now: database/create_table, database/insert_rows (changed and waits for an admin to approve it); fs/read (fs is not connected). If you need one, tell the person what blocks it.</brought_fns>',
      '</context>',
    ].join('\n'));
    // nothing added says nothing is in the tools
    expect(contextBlock({ name: 'database/guide', detail: 'full', text: 'Tables.', fns: { added: [], blocked: [held('database/create_table')] } })).not.toContain('in_tools="yes"');
    expect(contextBlock({ name: 'fs/guide', detail: 'full', text: 'Start.', choices: [{ to: 'fs/git', when: 'for commits', tokens: 40 }] })).toBe([
      '<context key="fs/guide">', 'Start.', '<choices>', 'Where to go next: load the one that fits by its key, or none.', '<choice key="fs/git" tokens="40">for commits</choice>', '</choices>', '</context>',
    ].join('\n'));
    expect(blockedFnsLine([{ fn: 'x/a', code: 'paused', reason: 'x/a is paused' }])).toBe('x/a (is paused)');
    expect(blockedLine('fs/off', { reason: 'fs/off is switched off' })).toBe('fs/off can\'t be used now: fs/off is switched off');
    expect(moreContext([])).toBe('');
    expect(moreContext([contextRecord('fs/git', { title: 'Git', description: 'Commits.\nMore.' })])).toBe('<more_context>\nLoad any of these by name if it helps:\n<context key="fs/git" title="Git">Commits.</context>\n</more_context>');
    expect(earlierBlock({ turn: 3, user: 'q', answer: 'a', used: ['fs/read'] })).toBe('<earlier turn="3">\nUser: q\nAnswer: a\nUsed: fs/read\n</earlier>');
    expect(resultText('fs/read', 'done', '3 lines')).toBe('<result fn="fs/read" status="done">\n3 lines\n</result>');
  });
});

describe('run blocks', () => {
  it('parse several blocks with prose around them, a missing fn and an unclosed block', () => {
    const parsed = parseRunBlocks('Let me look.\n<run fn="fs/read">{"path": "README.md"}</run>\nand\n<run fn=\'find\'>{"query":"git"}</run>\n<run>{}</run>\n<run fn="fs/bash">{"command": "ls"');
    expect(parsed.calls).toEqual([
      { fn: 'fs/read', json: '{"path": "README.md"}' },
      { fn: 'find', json: '{"query":"git"}' },
      { fn: undefined, json: '{}' },
      { fn: 'fs/bash', json: '{"command": "ls"' },
    ]);
    expect(parsed.prose).toBe('Let me look.\n\nand');
    expect(parseRunBlocks('No tools here; <running> is not a block.').calls).toEqual([]);
    expect(parseRunBlocks(`<run fn="fs/read" on='laptop'>{}</run><run on="" fn="fs/read">{}</run>`).calls).toEqual([
      { fn: 'fs/read', on: 'laptop', json: '{}' },
      { fn: 'fs/read', json: '{}' },
    ]);
    expect(parseRunBlocks('<think>maybe <run fn="fs/bash">{}</run>?</think>Answer: 3.')).toEqual({ calls: [], prose: 'Answer: 3.' });
  });

  it('hold a block back from the stream, even split across chunks, and let prose through', () => {
    const filter = new RunBlockFilter();
    const chunks = ['Reading ', 'it now.\n<r', 'un fn="fs/read">{"pa', 'th": "a"}</ru', 'n>\nDone', ' <runner'];
    const out = chunks.map((c) => filter.push(c)).join('') + filter.end();
    expect(out).toBe('Reading it now.\n\nDone <runner');
    const open = new RunBlockFilter();
    expect(open.push('x <run fn="a">{') + open.end()).toBe('x ');
  });
});

describe('history', () => {
  const transcript: LlmMessage[] = [
    { role: 'user', content: 'How many lines in README.md?\n\n<local_time>\n<now>Sat 10:00</now>\n</local_time>' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'run', arguments: '{"fn":"fs/read","args":{"path":"README.md"}}' }] },
    { role: 'tool', toolCallId: '1', content: 'x'.repeat(2_000) },
    { role: 'assistant', content: 'It has 88 lines. That is all. Anything else?' },
    { role: 'user', content: 'Load fs/guide please' },
    { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'hub__load_fns', arguments: '{"fns":["fs/bash"]}' }] },
    { role: 'tool', toolCallId: '2', content: '### fs/grep — Search files.' },
    { role: 'assistant', content: '<run fn="fs/bash">{"command":"ls"}</run>' },
    { role: 'user', content: '<result fn="fs/bash" status="done">\na b\n</result>' },
    { role: 'assistant', content: 'Two files.' },
  ];

  it('cut a transcript into exchanges that keep tool calls with their replies and text results', () => {
    const cut = exchanges(transcript);
    expect(cut.map((e) => e.messages.length)).toEqual([4, 6]);
    expect(cut[0]?.user).toBe('How many lines in README.md?');
    expect(cut[0]?.answer).toBe('It has 88 lines. That is all. Anything else?');
    expect(cut[0]?.used).toEqual(['fs/read']);
    expect(cut[1]?.used).toEqual(['hub__load_fns', 'fs/bash']);
    expect(cut[1]?.mentioned).toEqual(expect.arrayContaining(['fs/guide', 'fs/bash', 'fs/grep']));
    expect(isPersonMessage({ role: 'user', content: '<result fn="x" status="done">\n</result>' })).toBe(false);
  });

  it('summarise an exchange within a size, from its question and the first and last sentence of its answer', () => {
    const [first] = exchanges(transcript);
    if (first === undefined) throw new Error('no exchange');
    const summary = summarise(first, 120);
    const body = earlierBlock(summary).split('\n').slice(1, -1).join('\n');
    expect(body.length).toBeLessThanOrEqual(120);
    expect(body).toContain('User: How many lines');
    expect(body).toContain('Used: fs/read');
    expect(summary).toMatchObject({ turn: 0, used: ['fs/read'] });
    expect(firstAndLast('One. Two. Three. Four.')).toBe('One. … Four.');
    expect(firstAndLast('Just one')).toBe('Just one');
  });

  it('shorten results to their head and tail, and find the contiguous tail', () => {
    const long = 'a'.repeat(500) + 'b'.repeat(500);
    const short = shorten(long, 300);
    expect(short.length).toBeLessThan(400);
    expect(short.startsWith('a')).toBe(true);
    expect(short.endsWith('b')).toBe(true);
    expect(short).toContain('characters trimmed');
    expect(shorten('tiny', 300)).toBe('tiny');
    const trimmed = shortenResults(transcript.slice(0, 3), 300);
    expect(textOf(trimmed[2] ?? { role: 'tool', content: '' }).length).toBeLessThan(400);
    expect(trimmed[0]).toEqual(transcript[0]);
    expect(contiguousTail([true, false, true, true])).toBe(2);
    expect(contiguousTail([true, false])).toBe(0);
  });

  it('read a person\'s own words and the names they give', () => {
    expect(personWords('run fs/bash ls\n\n<suggested_fns>\n- fn fs/read\n</suggested_fns>')).toBe('run fs/bash ls');
    expect(namedIn('please run fs/bash and hub/load_fns, not a/b/c?')).toEqual(['fs/bash', 'hub/load_fns', 'a/b']);
  });
});

describe('thinking written into an answer', () => {
  it('streams it apart from the answer, across chunks that split a tag', () => {
    const filter = new ThinkingFilter();
    const parts = ['<thi', 'nk>Let me count', ' the lines.</th', 'ink>\n\nIt has ', '3 lines.'].map((chunk) => filter.push(chunk));
    const end = filter.end();
    expect(parts.map((p) => p.reasoning).join('') + end.reasoning).toBe('Let me count the lines.');
    expect((parts.map((p) => p.text).join('') + end.text).trim()).toBe('It has 3 lines.');
  });

  it('keeps a thought left open as reasoning, and an answer with no thinking as it is', () => {
    expect(splitThinking('<think>still thinking')).toEqual({ text: '', reasoning: 'still thinking' });
    expect(splitThinking('Just the answer, with a < sign.')).toEqual({ text: 'Just the answer, with a < sign.', reasoning: '' });
    expect(splitThinking('<think>a</think>One.<think>b</think> Two.')).toEqual({ text: 'One. Two.', reasoning: 'ab' });
  });
});
