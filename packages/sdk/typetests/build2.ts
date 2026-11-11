// Compile-time proof for build 2's SDK surface: fn examples, context links, invalid input and exposing fns, a
// system's place (instance, data and cache folders), the export lifecycle, every model modality through the hub,
// resource viewers beside the hub's, read-only inputs, agent modes and the hub contract's new fns. Nothing here runs:
// `npm run typecheck` fails if an expectation breaks, and every `@ts-expect-error` marks a mistake that must not compile.

import type { DefineComponent } from 'vue';
import {
  agent, client, context, expectType, fn, type FIND_KINDS, g, hub, system, type,
  type ChatModeType, type ContextorType, type Equal, type Infer, type InputViewOf, type LlmPayload, type ModelInput, type ModelOutput,
  type ResourceView, type WithSystem,
} from '@harness/sdk';
import { serve } from '@harness/sdk/server';
import type {
  ChatModeConfig, ContentRef, ContextorConfig, contextSlice, Detail, InstanceName, LinkTargetKind, ModelCallId, modelsSlice, resourcesSlice,
} from '@harness/core';
import type { z } from 'zod';

// ── Fn examples are typed by the fn's own args ────────────────────────────────

const Note = type({ description: 'A note.', shape: g.obj({ title: g.text(), body: g.text() }), display: { label: 'Note', title: 'title' } });

const notes = system('notes', { description: 'Notes.' })
  .with({ types: { Note } })
  .with(({ types }) => ({
    fns: {
      find: fn({
        description: 'Find notes.',
        args: g.obj({ query: g.text(), limit: g.optional(g.num()) }),
        returns: g.list(types.Note),
        examples: [{ args: { query: 'groceries' } }, { args: { query: 'plans', limit: 3 }, note: 'At most three.' }],
      }),
      open: fn({ description: 'Open a note.', args: g.obj({ title: g.text() }), returns: types.Note }),
    },
  }))
  .with(({ fns, types }) => ({
    context: {
      guide: context({
        description: 'How notes work.',
        content: 'Find, then open.',
        weight: 1.5,
        summary: 'Find, then open.',
        links: [
          { to: fns.find, relation: 'brings' },
          { to: types.Note, relation: 'related', weight: 0.4 },
          { to: { uri: 'file:///notes/README.md', section: 'Usage' }, relation: 'about' },
        ],
      }),
    },
  }))
  .with(({ context: ctx }) => ({
    context: { chapter: context({ description: 'One chapter.', content: '…', parent: ctx.guide, next: ctx.guide }) },
  }));

// @ts-expect-error an example's args must fit the fn's args type
fn({ description: 'x', args: g.obj({ query: g.text() }), returns: g.text(), examples: [{ args: { query: 3 } }] });
// @ts-expect-error an example must give the required args
fn({ description: 'x', args: g.obj({ query: g.text() }), returns: g.text(), examples: [{ args: {} }] });
// @ts-expect-error a context link's relation is one a system may declare (`learned` is the hub's to find)
context({ description: 'x', content: 'y', links: [{ to: notes.fns.find, relation: 'learned' }] });
// @ts-expect-error a context link points at a ref or a resource, not a bare name
context({ description: 'x', content: 'y', links: [{ to: 'notes/find', relation: 'brings' }] });
// @ts-expect-error a parent is a context ref
context({ description: 'x', content: 'y', parent: notes.fns.find });

// ── Invalid input, exposing fns, the system's place ───────────────────────────

void serve(notes, {
  fns: {
    find: {
      async run(args, ctx) {
        if (args.query.trim() === '') { return ctx.invalid([{ path: 'query', message: 'Say what to look for.' }]); }
        if (args.limit === 0) { return ctx.invalid('A limit of 0 finds nothing.'); }
        // the result shows the agent the fn to open a note with, at a detail
        ctx.expose(notes.fns.open, 'signature');
        ctx.expose(notes.fns.open);
        // @ts-expect-error a detail is listed, signature or full
        ctx.expose(notes.fns.open, 'everything');
        // @ts-expect-error only fn refs can be exposed
        ctx.expose(notes.types.Note);
        // @ts-expect-error problems are a message or { path, message } items
        void ctx.invalid([{ field: 'query' }]);
        expectType<Equal<typeof ctx.instance, InstanceName>>(true);
        expectType<Equal<typeof ctx.dataDir, string>>(true);
        expectType<Equal<typeof ctx.cacheDir, string>>(true);
        return ctx.done([]);
      },
    },
    open: { async run(args, ctx) { return ctx.done({ title: args.title, body: '' }); } },
  },
  lifecycle: {
    async started(ctx) { expectType<Equal<typeof ctx.dataDir, string>>(true); },
    // the hub waits up to `timeout` before copying the data folder
    async exporting(ctx) { expectType<Equal<typeof ctx.timeout, number>>(true); expectType<Equal<typeof ctx.instance, InstanceName>>(true); },
  },
}, { hub: '', state: '' });

// ── Every modality through the hub, typed by core's ModelForward ─────────────

void serve(notes, {
  fns: {
    find: {
      async run(_args, ctx) {
        const images = await ctx.llm.image({ prompt: 'a notebook', size: '512x512', count: 2 });
        expectType<Equal<typeof images.images, ContentRef[]>>(true);
        expectType<Equal<typeof images.call, ModelCallId>>(true);
        const heard = await ctx.llm.transcribe({ audio: images.images[0] ?? { hash: '', size: 0, mime: '' }, language: 'en' });
        expectType<Equal<typeof heard.text, string>>(true);
        const spoken = await ctx.llm.speak({ text: 'hi', format: 'ogg' });
        expectType<Equal<typeof spoken.audio, ContentRef>>(true);
        // @ts-expect-error a speech format the hub speaks
        void ctx.llm.speak({ text: 'hi', format: 'flac' });
        // @ts-expect-error an image needs a prompt
        void ctx.llm.image({ size: '1x1' });
        // @ts-expect-error the run is the runtime's to fill in
        void ctx.llm.image({ prompt: 'x', run: 'run_x' });
        return ctx.done([]);
      },
    },
    open: { async run(args, ctx) { return ctx.done({ title: args.title, body: '' }); } },
  },
}, { hub: '', state: '' });
expectType<Equal<ModelInput<'embed'>['texts'], string[]>>(true);
expectType<Equal<keyof ModelOutput<'transcribe'>, 'text' | 'segments' | 'call' | 'cost' | 'model'>>(true);

// ── Renderers: resource viewers beside the hub's, inputs that are their own viewers ──

declare const MarkdownTab: DefineComponent<ResourceView & WithSystem<typeof notes.defs>>;
declare const NoteInput: DefineComponent<InputViewOf<typeof notes, 'Note'>>;
client(notes, {
  inputs: { Note: NoteInput },
  resources: {
    // a bare component draws instead of the hub's preview
    'notes-note': MarkdownTab,
    // or it is one more mode beside the hub's own
    markdown: { component: MarkdownTab, mode: 'tab', label: 'Outline' },
  },
});
// @ts-expect-error a viewer either replaces the preview or adds a tab
client(notes, { resources: { markdown: { component: MarkdownTab, mode: 'popup' } } });
declare const WrongViewer: DefineComponent<{ other: number }>;
// @ts-expect-error a viewer's props are a ResourceView
client(notes, { resources: { markdown: { component: WrongViewer, mode: 'tab' } } });
// one component is a type's editor and its viewer: it is told which
expectType<Equal<InputViewOf<typeof notes, 'Note'>['readonly'], boolean>>(true);
// a viewer can offer the forms the hub made, and read any of them
declare const view: ResourceView;
void view.text('markdown');
// @ts-expect-error forms are core's form kinds
void view.text('rendered');

// ── Agents choose a chat mode and a contextor, typed by core's schemas ────────

agent({
  description: 'A small-model helper.',
  args: g.obj({}),
  returns: g.text(),
  instructions: 'Help.',
  mode: { type: 'static', protocol: 'text' },
  contextor: { type: 'graph', shares: { history: 0.5, context: 0.3, fns: 0.2 } },
  maxOutput: 512,
});
// @ts-expect-error a mode is one of core's chat modes
agent({ description: 'x', args: g.obj({}), returns: g.text(), instructions: 'x', mode: { type: 'loose' } });
// @ts-expect-error a static protocol is auto, native or text
agent({ description: 'x', args: g.obj({}), returns: g.text(), instructions: 'x', mode: { type: 'static', protocol: 'xml' } });
expectType<Equal<Infer<typeof ChatModeType>, z.input<typeof ChatModeConfig>>>(true);
expectType<Equal<Infer<typeof ContextorType>, z.input<typeof ContextorConfig>>>(true);
expectType<Equal<LlmPayload['mode'], z.input<typeof ChatModeConfig> | undefined>>(true);
expectType<Equal<LlmPayload['contextor'], z.input<typeof ContextorConfig> | undefined>>(true);

// ── The hub contract's build 2 fns are typed refs ─────────────────────────────

expectType<Equal<typeof hub.fns.fns_search.name, 'hub/fns_search'>>(true);
expectType<Equal<typeof hub.fns.resource_read.name, 'hub/resource_read'>>(true);
expectType<Equal<typeof hub.fns.set_model_role.name, 'hub/set_model_role'>>(true);
expectType<Equal<typeof hub.fns.chat_small.name, 'hub/chat_small'>>(true);
expectType<Equal<Infer<typeof hub.fns.inspect.args>['detail'], Detail | undefined>>(true);
// @ts-expect-error there is no such hub fn
void hub.fns.find_everything;

// ── A hub fn that stands for a web endpoint takes its body and gives its response ──

expectType<Equal<Infer<typeof hub.fns.resource_read.args>, z.input<typeof resourcesSlice.endpoints.readResource.cfg.body>>>(true);
expectType<Equal<Infer<typeof hub.fns.resource_read.returns>, z.input<typeof resourcesSlice.endpoints.readResource.cfg.response>>>(true);
// a body that is not one object (a union of shapes) is the fn's `input`
expectType<Equal<Infer<typeof hub.fns.set_model_role.args>, { input: z.input<typeof modelsSlice.endpoints.setModelRole.cfg.body> }>>(true);
expectType<Equal<Infer<typeof hub.fns.forget.returns>, z.input<typeof contextSlice.endpoints.forget.cfg.response>>>(true);
// @ts-expect-error a resource read needs its uri
void ((args: Infer<typeof hub.fns.resource_read.args>) => args)({});
// `FIND_KINDS` lists every kind of item a link can point at
expectType<Equal<(typeof FIND_KINDS)[number], LinkTargetKind>>(true);
expectType<Equal<LlmPayload['maxOutput'], number | undefined>>(true);
