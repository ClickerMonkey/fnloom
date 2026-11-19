/**
 * The test kit on a small notes system: a typed call with its progress and hub calls, a refused call, a scripted
 * model driving `ctx.ai()` with a tool call, a recording replayed (and refusing to invent a missing reply), a kind's
 * derived props, a context folder's links, an in-process render, and a component bundled for its preview.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { z } from 'zod';
import { kind } from '../declare.ts';
import { fn, linear } from '../fn.ts';
import { g } from '../gin.ts';
import { system, type SystemImpl } from '../system.ts';
import { replyChunks } from '../server/fake-models.ts';
import { CallNotDone, callFn, contextFolder, galleryHtml, mockModel, preview, renderHtml, testHub, toolCall, type TestSystem } from './index.ts';

const notes = system('notes', { description: 'Notes for the kit.' }).with({
  kinds: { template: kind({ description: 'A note from a template.', applicability: 'Templated notes.', payload: g.obj({ template: g.text() }) }) },
  fns: {
    echo: fn({ description: 'Echo text.', args: g.obj({ text: g.text(), at: g.optional(g.timestamp()) }), returns: g.obj({ text: g.text(), year: g.optional(g.num()) }), progress: linear }),
    title: fn({ description: 'A title for a note, from the model.', args: g.obj({ note: g.text() }), returns: g.text() }),
    picky: fn({ description: 'Refuses empty text.', args: g.obj({ text: g.text() }), returns: g.text() }),
  },
});

type Defs = (typeof notes)['defs'];

const impl: SystemImpl<Defs> = {
  fns: {
    echo: { async run(args, ctx) { ctx.progress.set(0.5, 'half'); return ctx.done({ text: args.text, ...(args.at === undefined ? {} : { year: args.at.getUTCFullYear() }) }); } },
    title: {
      async run(args, ctx) {
        const ai = await ctx.ai();
        const shorten = ai.tool({ name: 'shorten', description: 'Shorten a text.', schema: z.object({ text: z.string() }), call: (input: { text: string }) => input.text.slice(0, 5) });
        const prompt = ai.prompt({ name: 'title', description: 'Titles a note.', content: 'Title this note: {{note}}', input: (input: { note: string }) => input, tools: [shorten] });
        return ctx.done((await prompt.get('result', { note: args.note })) ?? '');
      },
    },
    picky: { async run(args, ctx) { return args.text === '' ? ctx.invalid([{ path: 'text', message: 'Give some text.' }]) : ctx.done(args.text); } },
  },
  kinds: {
    template: {
      async check(payload) { return payload.template.includes('{{') ? [] : ['A template needs a placeholder.']; },
      async describe() { return { args: { name: 'obj' }, returns: { name: 'text' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true }, examples: [{ args: {} }] }; },
      async run(payload, _args, ctx) { return ctx.done(payload.template); },
    },
  },
};

let kit: TestSystem<'notes', Defs> | undefined;
afterEach(async () => {
  await kit?.stop();
  kit = undefined;
});

describe('the test kit', () => {
  it('calls a fn with typed args: the typed result, its progress and what it asked the hub for', async () => {
    kit = await testHub(notes, impl);
    const { result, progress, hubCalls } = await kit.call('echo', { text: 'hi', at: new Date('2026-01-02T00:00:00Z') });
    expect(result).toEqual({ text: 'hi', year: 2026 });
    expect(progress.map((p) => p.progress)).toEqual([{ fraction: 0.5, message: 'half' }]);
    expect(hubCalls.forwards).toEqual([]);
    const refused = await kit.run('picky', { text: '' });
    expect(refused.outcome.status).toBe('invalid-input');
    await expect(kit.call('picky', { text: '' })).rejects.toBeInstanceOf(CallNotDone);
  });

  it('drives ctx.ai() with a scripted model, tool calls included, in one line', async () => {
    const model = mockModel([toolCall('shorten', { text: 'Groceries for Sunday' }), 'Groceries']);
    const { result, hubCalls } = await callFn(notes, impl, 'title', { note: 'Groceries for Sunday' }, { model });
    expect(result).toBe('Groceries');
    expect(hubCalls.forwards).toHaveLength(2);
    expect(hubCalls.forwards[0]?.request.tools?.map((t) => t.name)).toEqual(['shorten']);
    expect(JSON.stringify(hubCalls.forwards[1]?.request.messages)).toContain('Groce');
  });

  it('replays a recording, and refuses to invent a reply it does not have', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kit-'));
    try {
      const recording = join(dir, 'title.json');
      await writeFile(recording, JSON.stringify({ replies: [replyChunks('Recorded title')] }));
      kit = await testHub(notes, impl, { model: mockModel({ recording, live: undefined }) });
      expect((await kit.call('title', { note: 'x' })).result).toBe('Recorded title');
      const missing = await kit.run('title', { note: 'y' });
      expect(missing.outcome.status).toBe('failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives the problems and derived props a kind makes of a payload', async () => {
    kit = await testHub(notes, impl);
    expect(await kit.kindProps('template', { template: 'Hello' })).toMatchObject({ problems: ['A template needs a placeholder.'] });
    const good = await kit.kindProps('template', { template: 'Hello {{name}}' });
    expect(good.problems).toEqual([]);
    expect(good.description?.returns).toEqual({ name: 'text' });
  });

  it('checks a context folder: the fns each context brings, and broken links (fenced code skipped)', async () => {
    const checked = await contextFolder(fileURLToPath(new URL('./fixtures/context', import.meta.url)), notes);
    expect(checked.fns.get('notes/guide')).toEqual(['notes/echo']);
    expect(checked.problems).toHaveLength(1);
    expect(checked.problems[0]).toMatch(/guide\.md:\d+:\d+ .*notes\/list/);
  });

  it('renders a component in-process, and bundles a .vue component for its preview', async () => {
    const card = defineComponent({ props: { title: { type: String, default: '' } }, setup: (props) => () => h('h3', props.title) });
    expect(await renderHtml(card, { title: 'Hello' })).toBe('<h3>Hello</h3>');
    const shots = await preview({ name: 'NoteCard', module: new URL('./fixtures/NoteCard.vue', import.meta.url), states: { empty: {}, typical: { title: 'Shop', lines: ['Milk'] } }, shoot: false });
    expect(shots).toEqual([]);
    const gallery = galleryHtml([{ component: 'NoteCard', state: 'empty', viewport: 'phone', theme: 'dark', image: { hash: 'a'.repeat(64), size: 1, mime: 'image/png' } }]);
    expect(gallery).toContain('NoteCard · empty');
  }, 60_000);
});

describe('a kind fn under test', () => {
  it('runs a fn of a kind with a typed payload and JSON args', async () => {
    kit = await testHub(notes, impl);
    const run = await kit.runKind('template', 'greeting', { template: 'Hi {{name}}' }, { name: 'Tess' });
    expect(run.outcome).toMatchObject({ status: 'done', result: 'Hi {{name}}' });
    expect(run.hubCalls.calls).toEqual([]);
  });
});
