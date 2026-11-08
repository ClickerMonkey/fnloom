/**
 * `serve` end to end against the in-memory hub: handshake and pairing, manifest, config and lifecycle, typed runs and
 * their outcomes, progress, attachments, settings, state, child calls and handlers, pause and resume by call key,
 * cancel, forms, actions, mentions, hooks, context, resources, runtime adds and removes, reconnects, restart and stop.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualify, type Json, type OutcomeWire, type RunSettled } from '@harness/core';
import { action, attachment, context, embedder, hook, kind, mention, sectioner, sectionKeys, setting, type } from '../declare.ts';
import { fn, handler, linear, steps } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { createLogger } from '@ayepi/log';
import { serve, type RunningSystem } from './index.ts';
import type { LinkTransport } from './link.ts';
import { FakeHub, TEST_USER } from './testing.ts';
import { Deferred } from './wire.ts';

const Note = type({ description: 'A note.', shape: g.obj({ id: g.text(), title: g.text() }), display: { label: 'Note', title: 'title' }, methods: {
  shout: fn({ description: 'The title, loud.', args: g.obj({ times: g.num({ min: 1, whole: true }) }), returns: g.text() }),
} });

const notes = system('notes', { description: 'Notes for tests.' })
  .with({
    config: g.obj({ folder: g.text() }),
    types: { Note },
    settings: { tone: setting({ description: 'How notes sound.', type: g.enum(['calm', 'loud']), appliesTo: ['user'], merge: 'user-wins' }) },
    attachments: { card: attachment({ description: 'A note card.', data: g.obj({ id: g.text() }) }) },
    kinds: { template: kind({ description: 'A note from a template.', applicability: 'Templated notes.', payload: g.obj({ template: g.text() }) }) },
    fns: {
      echo: fn({ description: 'Echo text.', args: g.obj({ text: g.text(), at: g.optional(g.timestamp()) }), returns: g.obj({ text: g.text(), year: g.optional(g.num()) }), progress: linear }),
      stepped: fn({ description: 'Two steps.', args: g.obj({}), returns: g.bool(), progress: steps({ read: 'Read', write: 'Write' }) }),
      write: fn({ description: 'Write a note.', args: g.obj({ id: g.text() }), returns: g.obj({ ok: g.bool() }), undo: g.obj({ id: g.text() }) }),
      cd: fn({ description: 'Set the folder.', args: g.obj({ path: g.text() }), returns: g.text(), state: g.obj({ cwd: g.text() }) }),
      pwd: fn({ description: 'Show the folder.', args: g.obj({}), returns: g.text(), state: g.obj({ cwd: g.text() }) }),
      ask: fn({ description: 'Ask the caller.', args: g.obj({}), returns: g.bool(), handlers: { confirm: handler({ description: 'OK?', args: g.obj({ q: g.text() }), returns: g.bool(), required: false }) } }),
      wait: fn({ description: 'Wait for cancel.', args: g.obj({}), returns: g.text() }),
      approve: fn({ description: 'Ask for approval.', args: g.obj({}), returns: g.obj({ yes: g.bool() }), form: g.obj({ yes: g.bool() }) }),
      bad: fn({ description: 'Returns the wrong shape.', args: g.obj({}), returns: g.num() }),
      boom: fn({ description: 'Throws.', args: g.obj({}), returns: g.num() }),
      tone: fn({ description: 'Read the tone setting.', args: g.obj({}), returns: g.text() }),
      spend: fn({ description: 'Spends money.', args: g.obj({}), returns: g.text() }),
      guard: fn({ description: 'Turns cancel off while it works, and registers its undo early.', args: g.obj({}), returns: g.text(), undo: g.obj({ id: g.text() }) }),
      hang: fn({ description: 'Ignores its signal.', args: g.obj({}), returns: g.text() }),
    },
    hooks: { recent: hook({ description: 'Recent notes.' }) },
    embedders: { tiny: embedder({ dimensions: 2, maxInput: 100, pricePerMillionTokens: 0 }) },
    sectioners: { lines: sectioner({ description: 'One section per line.', match: { format: 'text' } }) },
    actions: { rename: action({ description: 'Rename.', input: g.obj({ title: g.text() }), returns: g.text(), state: g.obj({ cwd: g.text() }) }) },
  })
  .with(({ types, fns }) => ({
    mentions: { notes: mention({ title: 'Notes', description: 'Any note.', target: g.obj({ id: g.text() }), of: types.Note }) },
    context: {
      guide: context({ description: 'How.', content: 'Write short notes.' }),
      list: context({ description: 'The notes.', command: { name: 'notes', args: {} } }),
    },
    fns: {
      copy: fn({
        description: 'Copy via echo twice.',
        args: g.obj({ text: g.text() }),
        returns: g.text(),
        deps: { echo: fns.echo },
        resume: g.obj({ at: g.num() }),
      }),
    },
  }));

type Notes = typeof notes;

let running: RunningSystem<'notes'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function impl(overrides: { onPauseCopy?: boolean } = {}): Parameters<typeof serve<'notes', Notes['defs']>>[1] {
  return {
    fns: {
      echo: { async run(args, ctx) { ctx.progress.set(0.5, 'half'); return ctx.done({ text: args.text, ...(args.at === undefined ? {} : { year: args.at.getUTCFullYear() }) }); } },
      stepped: { async run(_a, ctx) { ctx.progress.step('read', 'done'); ctx.progress.step('write', 'active', 'writing'); return ctx.done(true); } },
      write: {
        async run(args, ctx) {
          ctx.attach(notes.attachments.card, { id: args.id }, 'Note');
          ctx.link({ url: 'https://example.com/n', title: 'Example' });
          return ctx.done({ ok: true }, { undo: { id: args.id } });
        },
        async undo(payload) { return { status: 'undone', summary: `removed ${payload.id}` }; },
      },
      cd: { async run(args, ctx) { await ctx.state.set({ cwd: args.path }); return ctx.done(args.path); } },
      pwd: { async run(_a, ctx) { const { cwd } = await ctx.state.get(); return ctx.done(cwd ?? '(none)'); } },
      ask: { async run(_a, ctx) { return ctx.done(ctx.handlers.confirm === undefined ? false : await ctx.handlers.confirm({ q: 'go?' })); } },
      wait: {
        async run(_a, ctx) {
          await new Promise<void>((resolve) => { ctx.signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
          return ctx.cancelled({ partial: 'stopped' });
        },
      },
      approve: { async run(_a, ctx) { return ctx.done(await ctx.form()); } },
      bad: { async run(_a, ctx) { return ctx.done('nope' as unknown as number); } }, // eslint-disable-line @typescript-eslint/consistent-type-assertions -- deliberately wrong at runtime
      boom: { async run() { throw new Error('kaboom'); } },
      tone: { async run(_a, ctx) { return ctx.done((await ctx.setting(notes.settings.tone)) ?? 'unset'); } },
      guard: {
        async run(_a, ctx) {
          ctx.allow({ cancel: false });
          ctx.undoWith({ id: 'g1' });
          await guardGate.promise;
          return ctx.done('kept');
        },
        async undo(payload) { return { status: 'undone', summary: payload.id }; },
      },
      hang: { async run() { return new Promise<never>(() => undefined); } },
      spend: { async run(_a, ctx) { ctx.budget.spend(0.25, 'paid api'); return ctx.done(`${ctx.budget.remaining().cost}`); } },
      copy: {
        async run(args, ctx) {
          if (overrides.onPauseCopy === true) { ctx.onPause(() => ({ at: 1 })); }
          const first = await ctx.fns.echo({ text: args.text });
          const second = await ctx.fns.echo({ text: `${args.text}!` });
          return ctx.done(`${first.text}+${second.text}`);
        },
      },
    },
    types: { Note: { shout: { async run(self, args, ctx) { return ctx.done(`${self.title.toUpperCase()}${'!'.repeat(args.times)}`); } } } },
    kinds: {
      template: {
        async check(payload) { return payload.template.includes('{{') ? [] : ['A template needs a placeholder.']; },
        async describe() { return { args: { name: 'obj' }, returns: { name: 'text' }, deps: [], operations: { cancel: true, pause: false, undo: false, background: true } }; },
        async run(payload, args, ctx) { return ctx.done(`${payload.template}:${JSON.stringify(args)}`); },
      },
    },
    hooks: { recent: async (input) => [{ type: 'text', tag: 'recent', text: `for ${input.user.name}` }, { type: 'suggest-fns', items: [{ fn: notes.fns.echo }] }] },
    mentions: {
      notes: {
        async search(query, ctx) { return [{ label: `${query} note`, target: { id: `n-${ctx.user.name}` } }]; },
        async hover(target) { return { title: target.id, value: { id: target.id, title: 'Hello' } }; },
        async llm(target) { return `Note ${target.id}.`; },
      },
    },
    context: { list: async (_args, ctx) => `notes in ${ctx.config.folder} for ${ctx.user.name}` },
    embedders: { tiny: async (texts) => texts.map((t) => [t.length, 0]) },
    sectioners: { lines: async (text) => sectionKeys(text.split('\n').map((l) => [l])).map((key, i) => ({ key, path: [key], title: key, start: i, end: i + 1 })) },
    actions: { rename: async (input, ctx) => { const { cwd } = await ctx.state.get(); return `${input.title} in ${cwd ?? '-'}`; } },
    resources: {
      async roots() { return [{ uri: 'notes://all', name: 'All', description: 'Every note.', index: 'all', ignore: [], watch: true }]; },
      async list() { return { items: [] }; },
      async stat(uri) { return uri === 'notes://a' ? { uri, name: 'a', type: 'record', version: '1' } : undefined; },
      async read(uri) { return { stat: { uri, name: 'a', type: 'record', version: '1' }, text: { inline: uri === 'notes://big' ? 'x'.repeat(2_000) : 'hello' } }; },
      watch(_uris, onChange) {
        const timer = setTimeout(() => { onChange([{ uri: 'notes://a', change: 'changed' }]); }, 5);
        return () => { clearTimeout(timer); };
      },
    },
    lifecycle: {
      started: async (ctx) => { lifecycle.push(`started:${ctx.config.folder}`); },
      installed: async () => { lifecycle.push('installed'); },
      configured: async (ctx) => { lifecycle.push(`configured:${ctx.previous?.folder ?? 'none'}->${ctx.config.folder}`); },
      stopping: async (ctx) => { lifecycle.push(`stopping:${ctx.reason}`); },
    },
  };
}

const lifecycle: string[] = [];

/** Releases the `guard` fn; replaced per test. */
let guardGate = new Deferred<void>();

async function start(hub: FakeHub, options: { onPauseCopy?: boolean } = {}): Promise<RunningSystem<'notes'>> {
  lifecycle.length = 0;
  running = await serve(notes, impl(options), { hub: 'ws://hub.test/link', state: 'unused', version: '1.2.3' }, hub.host());
  await running.ready();
  return running;
}

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

describe('connecting', () => {
  it('says hello, proves its key, sends its manifest and starts once configured', async () => {
    const hub = new FakeHub({ config: { folder: '/notes' } });
    const system = await start(hub);
    expect(system.status).toBe('connected');
    expect(hub.hellos[0]).toMatchObject({ name: 'notes' });
    expect(hub.manifests[0]?.name).toBe('notes');
    expect(hub.manifests[0]?.version).toBe('1.2.3');
    expect(hub.manifests[0]?.resources).toBe(true);
    expect(lifecycle).toEqual(['installed', 'started:/notes']);
  });

  it('waits as needs-config until the hub sets a valid config, then starts', async () => {
    const hub = new FakeHub();
    lifecycle.length = 0;
    running = await serve(notes, impl(), { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
    const statuses: string[] = [];
    running.onStatus((s) => statuses.push(s));
    await hub.whenConnected();
    await vi.waitFor(() => { expect(running?.status).toBe('needs-config'); });
    await hub.configure({ folder: '/a' });
    await running.ready();
    expect(lifecycle).toEqual(['installed', 'started:/a']);
    await hub.configure({ folder: '/b' });
    expect(lifecycle.at(-1)).toBe('configured:/a->/b');
    expect(statuses).toContain('connected');
  });

  it('pairs a new name: waits for approval, then says hello again and is welcomed', async () => {
    const hub = new FakeHub({ pairing: true, config: { folder: '/p' } });
    running = await serve(notes, impl(), { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
    await vi.waitFor(() => { expect(running?.status).toBe('pairing'); });
    await hub.approve('notes');
    await running.ready();
    expect(hub.hellos).toHaveLength(2);
    expect(hub.keys.has('notes')).toBe(true);
  });

  it('skips the manifest when the hub already has its hash, and sends it again after a change', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    const system = await start(hub);
    hub.drop(5);
    await hub.whenConnected();
    await vi.waitFor(() => { expect(system.status).toBe('connected'); });
    expect(hub.manifests).toHaveLength(1);
    expect(hub.hellos).toHaveLength(2);
  });

  it('uploads its client renderers with its manifest, and not again when the hub already has them', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'harness-client-'));
    try {
      const entry = 'export default {};\n';
      await writeFile(join(folder, 'index.js'), entry);
      await writeFile(join(folder, 'style.css'), '.a { color: red; }\n');
      const hub = new FakeHub({ config: { folder: '/n' } });
      lifecycle.length = 0;
      running = await serve(notes, impl(), { hub: 'ws://hub.test/link', state: 'unused', version: '1', client: folder }, hub.host());
      await running.ready();
      const assets = hub.manifests[0]?.client;
      expect(assets?.entry).toBe('index.js');
      expect(assets?.files.map((f) => f.path).sort()).toEqual(['index.js', 'style.css']);
      // every file reached the hub before the manifest that lists it
      for (const file of assets?.files ?? []) { expect(hub.content.has(file.hash)).toBe(true); }
      expect(new TextDecoder().decode(hub.content.get(assets?.files.find((f) => f.path === 'index.js')?.hash ?? ''))).toBe(entry);
      const stored = hub.content.size;
      hub.content.clear();
      hub.drop(5);
      await hub.whenConnected();
      await vi.waitFor(() => { expect(running?.status).toBe('connected'); });
      expect(hub.manifests).toHaveLength(1);
      expect(hub.content.size).toBe(0);
      expect(stored).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe('running fns', () => {
  it('checks args and gives plain values (timestamps as Date), and encodes the result', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(done(await hub.run('notes/echo', { text: 'hi', at: '2026-11-07T00:00:00.000Z' }))).toEqual({ text: 'hi', year: 2026 });
    expect(hub.progress).toContainEqual(expect.objectContaining({ progress: { fraction: 0.5, message: 'half' } }));
  });

  it('refuses args that do not fit as invalid input, with the problems by path, without running the fn', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const outcome = await hub.run('notes/echo', { text: 3 });
    expect(outcome).toMatchObject({ status: 'invalid-input', invalid: { source: 'schema' } });
    expect(outcome.status === 'invalid-input' ? outcome.invalid.problems.map((p) => p.path) : []).toContain('text');
    expect(hub.progress).toEqual([]);
  });

  it('reports a result that does not fit its declared type as fatal, and a thrown error as fatal', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(await hub.run('notes/bad', {})).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'bad-value' } });
    expect(await hub.run('notes/boom', {})).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'threw', message: 'kaboom' } });
    expect(await hub.run('notes/missing', {})).toMatchObject({ status: 'failed', error: { code: 'not-found' } });
  });

  it('reports named steps', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(done(await hub.run('notes/stepped', {}))).toBe(true);
    expect(hub.progress.map((p) => p.progress)).toEqual([{ step: 'read', status: 'done' }, { step: 'write', status: 'active', detail: 'writing' }]);
  });

  it('sends checked attachments and links, and the undo payload with the outcome; undo runs the implementation', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const outcome = await hub.run('notes/write', { id: 'n1' });
    expect(outcome).toEqual({ status: 'done', result: { ok: true }, undo: { id: 'n1' } });
    expect(hub.attachments.map((a) => a.item)).toEqual([{ attachment: 'notes/card', data: { id: 'n1' }, title: 'Note' }, { link: { url: 'https://example.com/n', title: 'Example' } }]);
    const undone = await hub.peer().call('undo', { run: hub.runInfo('notes/write'), fn: 'write', kind: 'native', payload: { id: 'n1' } });
    expect(undone).toEqual({ status: 'undone', summary: 'removed n1' });
  });

  it('answers a run sent again from the journal instead of running it twice', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const request = hub.request('notes/write', { id: 'twice' });
    await hub.peer().call('run', request);
    await hub.peer().call('run', request);
    expect(hub.attachments.filter((a) => JSON.stringify(a.item).includes('twice'))).toHaveLength(1);
  });

  it('reads the user\'s setting, typed', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(done(await hub.run('notes/tone', {}))).toBe('unset');
    hub.settings.set('notes/tone', 'loud');
    expect(done(await hub.run('notes/tone', {}))).toBe('loud');
  });

  it('adds reported spend to the outcome cost and to what is left', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(await hub.run('notes/spend', {})).toEqual({ status: 'done', result: '0.75', cost: 0.25 });
  });

  it('keeps session state fields through the hub', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const run = hub.runInfo('notes/cd');
    await hub.run('notes/cd', { path: '/tmp' }, { run });
    expect(hub.state.get(`run:${run.id}`)?.values).toEqual({ cwd: '/tmp' });
  });

  it('calls its caller\'s handlers only when offered, and decodes the answer', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(done(await hub.run('notes/ask', {}))).toBe(false);
    hub.onHandle = () => Promise.resolve({ ok: true, value: true });
    expect(done(await hub.run('notes/ask', {}, { handlers: ['confirm'] }))).toBe(true);
    expect(hub.handled[0]).toMatchObject({ handler: 'confirm', args: { q: 'go?' } });
  });

  it('cancels a running fn, which reports what it managed', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const run = hub.runInfo('notes/wait');
    const outcome = hub.run('notes/wait', {}, { run });
    await new Promise((r) => setTimeout(r, 20));
    expect(await hub.peer().call('control', { run: run.id, action: 'cancel' })).toEqual({ accepted: true });
    expect(await outcome).toEqual({ status: 'cancelled', partial: 'stopped' });
  });

  it('times out at the deadline as a retryable failure, even when the fn answers the signal with cancelled', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const outcome = await hub.run('notes/wait', {}, { deadline: Date.now() + 30 });
    expect(outcome).toMatchObject({ status: 'failed', error: { class: 'retry', code: 'timeout' } });
    expect(JSON.stringify(outcome)).toContain('deadline');
  });

  it('settles at the deadline when the fn ignores its signal', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(await hub.run('notes/hang', {}, { deadline: Date.now() + 30 })).toMatchObject({ status: 'failed', error: { class: 'retry', code: 'timeout' } });
  });

  it('refuses a cancel the fn turned off, tells the hub, and sends an undo registered early', async () => {
    guardGate = new Deferred<void>();
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const run = hub.runInfo('notes/guard');
    const outcome = hub.run('notes/guard', {}, { run });
    await vi.waitFor(() => { expect(hub.allowed).toEqual([{ run: run.id, operations: { cancel: false } }]); });
    expect(hub.undos).toEqual([{ run: run.id, undo: { id: 'g1' } }]);
    const reply = await hub.peer().call('control', { run: run.id, action: 'cancel' });
    expect(reply.accepted).toBe(false);
    expect(reply.reason).toBeTypeOf('string');
    guardGate.resolve(undefined);
    expect(await outcome).toEqual({ status: 'done', result: 'kept', undo: { id: 'g1' } });
  });

  it('fails a run on a config version it has not been sent, as retryable', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(await hub.run('notes/echo', { text: 'x' }, { configVersion: 99 })).toMatchObject({ status: 'failed', error: { class: 'retry', code: 'config' } });
  });

  it('refuses a form value that does not fit and keeps waiting for one that does', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const run = hub.runInfo('notes/approve');
    const outcome = hub.run('notes/approve', {}, { run });
    await new Promise((r) => setTimeout(r, 20));
    await expect(hub.peer().call('form', { delivery: 'dlv_1', run: run.id, value: { yes: 'maybe' } })).rejects.toThrow();
    await hub.peer().call('form', { delivery: 'dlv_1', run: run.id, value: { yes: false } });
    expect(done(await outcome)).toEqual({ yes: false });
  });

  it('waits in ctx.form() for the renderer\'s submission, checked', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const run = hub.runInfo('notes/approve');
    const outcome = hub.run('notes/approve', {}, { run });
    await new Promise((r) => setTimeout(r, 20));
    await hub.peer().call('form', { delivery: 'dlv_1', run: run.id, value: { yes: true } });  
    expect(done(await outcome)).toEqual({ yes: true });
  });

  it('runs a type\'s method with the value as self', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    expect(done(await hub.run('notes/Note.shout', { self: { id: '1', title: 'hey' }, times: 2 }))).toBe('HEY!!');
  });

  it('runs a fn of its kind with the payload checked, and checks payloads', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const outcome = await hub.run('other/greet', { name: 'Ann' }, { kind: 'notes/template', payload: { template: 'Hi {{name}}' } });
    expect(done(outcome)).toBe('Hi {{name}}:{"name":"Ann"}');
    expect(await hub.peer().call('check', { kind: 'template', payload: { template: 'plain' } })).toEqual({ problems: ['A template needs a placeholder.'] });
    expect((await hub.peer().call('check', { kind: 'template', payload: { template: '{{x}}' } })).description?.returns).toEqual({ name: 'text' });
  });
});

describe('calling other fns', () => {
  it('calls deps through the hub with keys, and decodes their results', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    hub.onCall = (call) => Promise.resolve<RunSettled>({ status: 'done', result: { text: `got ${(call.args as { text: string }).text}` } }); // eslint-disable-line @typescript-eslint/consistent-type-assertions -- echo's args
    expect(done(await hub.run('notes/copy', { text: 'a' }))).toBe('got a+got a!');
    expect(hub.calls.map((c) => [c.fn, c.key])).toEqual([['notes/echo', 'echo#1'], ['notes/echo', 'echo#2']]);
  });

  it('pauses while waiting on a call, then resumes without repeating finished calls', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub, { onPauseCopy: true });
    let release: (() => void) | undefined;
    hub.onCall = (call) => call.key === 'echo#1'
      ? Promise.resolve({ status: 'done', result: { text: 'one' } })
      : new Promise((resolve) => { release = () => { resolve({ status: 'done', result: { text: 'late' } }); }; });
    const run = hub.runInfo('notes/copy');
    const first = hub.run('notes/copy', { text: 'a' }, { run });
    await vi.waitFor(() => { expect(hub.calls).toHaveLength(2); });
    expect(await hub.peer().call('control', { run: run.id, action: 'pause' })).toEqual({ accepted: true });
    expect(await first).toEqual({ status: 'paused', resume: { at: 1 } });
    release?.();
    hub.calls.length = 0;
    hub.onCall = () => Promise.resolve({ status: 'done', result: { text: 'two' } });
    const resumed = await hub.run('notes/copy', { text: 'a' }, {
      resume: { state: { at: 1 }, calls: { 'echo#1': { status: 'done', result: { text: 'one' } } }, reason: 'resumed' },
    });
    expect(done(resumed)).toBe('one+two');
    expect(hub.calls.map((c) => c.key)).toEqual(['echo#2']);
  });

  it('refuses to pause a fn with no pause hook', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    hub.onCall = () => new Promise(() => undefined);
    const run = hub.runInfo('notes/copy');
    void hub.run('notes/copy', { text: 'a' }, { run });
    await vi.waitFor(() => { expect(hub.calls).toHaveLength(1); });
    expect((await hub.peer().call('control', { run: run.id, action: 'pause' })).accepted).toBe(false);
    await hub.peer().call('control', { run: run.id, action: 'cancel' });
  });

  it('turns a failed dep into the run\'s failure', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    hub.onCall = () => Promise.resolve({ status: 'failed', error: { class: 'caller', message: 'no such file', code: 'not-found' } });
    expect(await hub.run('notes/copy', { text: 'a' })).toMatchObject({ status: 'failed', error: { message: 'no such file', code: 'not-found' } });
  });
});

describe('everything else the hub asks', () => {
  it('runs hooks, mentions, context, embedders, sectioners and actions with who is asking', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const peer = hub.peer();
    const asker = { session: 'ses_1' as never, actor: TEST_USER.id, user: TEST_USER, time: { now: 0, timeZone: 'UTC', local: '1970-01-01T00:00:00Z' } }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- a test session id
    expect(await peer.call('hook', { hook: 'recent', message: { session: asker.session, turn: 'trn_1', text: 'hi', user: TEST_USER, time: asker.time } }))  
      .toEqual([{ type: 'text', tag: 'recent', text: 'for Tess Tester' }, { type: 'suggest-fns', items: [{ fn: 'notes/echo' }] }]);
    expect(await peer.call('mentions', { ...asker, provider: 'notes', query: 'my' })).toEqual([{ label: 'my note', target: { id: 'n-Tess Tester' } }]);
    expect(await peer.call('mentionHover', { ...asker, provider: 'notes', target: { id: 'x' } })).toEqual({ hover: { title: 'x', value: { id: 'x', title: 'Hello' } } });
    expect(await peer.call('mentionText', { ...asker, provider: 'notes', target: { id: 'x' } })).toEqual({ text: 'Note x.' });
    expect(await peer.call('context', { ...asker, name: 'list', args: {} })).toEqual({ text: 'notes in /n for Tess Tester' });
    expect(await peer.call('context', { ...asker, name: 'guide', args: {} })).toEqual({ text: 'Write short notes.' });
    expect(await peer.call('embed', { embedder: 'tiny', texts: ['ab', 'abc'] })).toEqual({ vectors: [[2, 0], [3, 0]] });
    hub.state.set('delivery:dlv_9', { values: { cwd: '/w' }, version: 1 });
    expect(await peer.call('action', { ...asker, delivery: 'dlv_9', action: 'rename', input: { title: 'T' } })).toEqual({ result: 'T in /w' });  
    await expect(peer.call('action', { ...asker, delivery: 'dlv_9', action: 'rename', input: { title: 3 } })).rejects.toThrow();  
  });

  it('serves resources, long text by ref the hub can fetch, and reports watched changes', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    const peer = hub.peer();
    expect((await peer.call('roots'))[0]?.uri).toBe('notes://all');
    expect(await peer.call('stat', { uri: 'notes://a' })).toEqual({ stat: { uri: 'notes://a', name: 'a', type: 'record', version: '1' } });
    expect(await peer.call('stat', { uri: 'notes://none' })).toEqual({});
    expect((await peer.call('read', { uri: 'notes://a', want: ['text'] })).text).toEqual({ inline: 'hello' });
    await peer.call('watch', { uris: ['notes://a'], on: true });
    await vi.waitFor(() => { expect(hub.changes).toEqual([{ uri: 'notes://a', change: 'changed' }]); });
  });

  it('adds and removes fns at runtime with patches, and runs the added ones', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    const system = await start(hub);
    const ref = await system.add('shout', fn({ description: 'Shout.', args: g.obj({ text: g.text() }), returns: g.text() }), {
      async run(args, ctx) { return ctx.done(args.text.toUpperCase()); },
    });
    expect(ref.name).toBe(qualify('notes', 'shout'));
    expect(hub.patches[0]?.upsert.fns?.[0]?.name).toBe('shout');
    expect(done(await hub.run('notes/shout', { text: 'hey' }))).toBe('HEY');
    await system.remove(ref);
    expect(hub.patches[1]?.remove.fns).toEqual(['shout']);
    expect(await hub.run('notes/shout', { text: 'hey' })).toMatchObject({ status: 'failed' });
  });

  it('forwards LLM calls through the hub with the run on them', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    const system = await start(hub);
    await system.add('summarize', fn({ description: 'Summarize.', args: g.obj({}), returns: g.text() }), {
      async run(_a, ctx) { return ctx.done(await ctx.llm.text({ prompt: 'say ok', model: { model: 'test/model' } })); },
    });
    const run = hub.runInfo('notes/summarize');
    expect(done(await hub.run('notes/summarize', {}, { run }))).toBe('ok');
    expect(hub.forwards[0]).toMatchObject({ run: run.id, model: { model: 'test/model' }, stream: true });
  });

  it('restarts when the hub asks: stopping runs first, then the process restarts', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    await start(hub);
    await hub.peer().call('restart', { reason: 'new code' });
    await vi.waitFor(() => { expect(hub.process.restarts).toHaveLength(1); });
    expect(lifecycle).toContain('stopping:restart');
  });

  it('stops: lifecycle, then the link closes and it reports stopped', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    const system = await start(hub);
    await system.stop();
    expect(system.status).toBe('stopped');
    expect(lifecycle.at(-1)).toBe('stopping:shutdown');
    running = undefined;
  });

  it('stops when the hub removes it: stopping, then the process exits', async () => {
    const hub = new FakeHub({ config: { folder: '/n' } });
    const system = await start(hub);
    await hub.peer().call('stop', { reason: 'removed', timeout: 500 });
    await vi.waitFor(() => { expect(hub.process.exits).toEqual([0]); });
    expect(lifecycle).toContain('stopping:removed');
    expect(system.status).toBe('stopped');
    running = undefined;
  });

  it('logs that the hub is unreachable after connectTimeout, and keeps trying', async () => {
    const lines: string[] = [];
    const never: LinkTransport = {
      open: () => ({
        state: 'connecting', connect: () => undefined, close: () => undefined, send: () => undefined, onMessage: () => undefined, onState: () => () => undefined,
      }),
    };
    const hub = new FakeHub();
    running = await serve(notes, impl(), { hub: 'ws://nowhere.test/link', state: 'x', version: '1', connectTimeout: 20 }, hub.host({
      transport: never,
      logger: () => createLogger({ level: 'debug', transports: [{ name: 'mem', write: (record) => { lines.push(record.msg); } }] }),
    }));
    await vi.waitFor(() => { expect(lines).toContain('system.hub-unreachable'); });
    expect(running.status).toBe('connecting');
  });
});

