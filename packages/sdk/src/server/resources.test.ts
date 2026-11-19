/** Resources both ways (`ctx.resources` through the hub; serving reads, sections and content to it), events and edges. */
import { reject } from '@ayepi/core';
import { InstallSubject, QualifiedName, ResourceUri, SectionKey, type ResourceRead } from '@harness/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sectioner, sectionKeys, kind } from '../declare.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { sdkEnv, type SdkEnv } from './env.ts';
import { FakeHub, TEST_USER } from './testing.ts';

const docs = system('docs', { description: 'Documents.' }).with({
  fns: {
    peek: fn({ description: 'Read a resource.', args: g.obj({ uri: g.text() }), returns: g.obj({ text: g.text(), links: g.num(), known: g.bool() }) }),
    deep: fn({ description: 'Search resources.', args: g.obj({}), returns: g.text() }),
    outline: fn({ description: 'List a resource\x27s sections.', args: g.obj({ uri: g.text() }), returns: g.list(g.text()) }),
  },
  kinds: { macro: kind({ description: 'A macro.', applicability: 'Macros.', payload: g.obj({ steps: g.list(g.text()) }) }) },
  sectioners: { lines: sectioner({ description: 'Lines.', match: {} }) },
});

let running: RunningSystem<'docs'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const events: string[] = [];
const undone: string[] = [];

async function start(hub: FakeHub): Promise<void> {
  running = await serve(docs, {
    fns: {
      peek: {
        async run(args, ctx) {
          const uri = ResourceUri.parse(`doc://${args.uri}`);
          const stat = await ctx.resources.stat(uri);
          const text = stat === undefined ? '' : await ctx.resources.text(uri);
          const links = stat === undefined ? [] : await ctx.resources.links(uri);
          return ctx.done({ text, links: links.length, known: stat !== undefined });
        },
      },
      deep: {
        async run(_a, ctx) {
          await expect(ctx.resources.search('x')).rejects.toThrow(/person to search as/);
          await expect(ctx.resources.text('doc://a', [SectionKey.parse('a')])).rejects.toThrow(/whole text/);
          return ctx.done('ok');
        },
      },
      outline: {
        async run(args, ctx) {
          const sections = await ctx.resources.sections(ResourceUri.parse(`doc://${args.uri}`));
          return ctx.done(sections.map((section) => section.title));
        },
      },
    },
    kinds: {
      macro: {
        async check() { return []; },
        async describe() { return { args: { name: 'obj' }, returns: { name: 'any' }, deps: [], operations: { cancel: true, pause: false, undo: true, background: true }, examples: [{ args: {} }] }; },
        async run(payload, _args, ctx) { return ctx.done(payload.steps.length, { undo: { count: payload.steps.length } }); },
        async undo(payload, undo) { undone.push(`${payload.steps.join(',')}:${JSON.stringify(undo)}`); return { status: 'undone', summary: 'reverted' }; },
      },
    },
    sectioners: { lines: async (text, stat) => sectionKeys(text.split('\n').map((line) => [stat.name, line])).map((key, i) => ({ key, path: [key], title: key, start: i, end: i + 1 })) },
    resources: {
      async roots() { return []; },
      async list(uri) { return { items: [{ uri, name: 'child', type: 'file', version: '1' }], cursor: 'next' }; },
      async stat() { return undefined; },
      async read(uri) { return { stat: { uri, name: 'big', type: 'file', version: '1' }, text: { inline: 'é'.repeat(800) } }; },
    },
    events: {
      message: async (event) => { events.push(`message:${event.message.text}`); },
      fns: async (event) => { events.push(`fns:${event.added.join(',')}`); },
    },
  }, { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host({ env: { ...defaultEnv(), HARNESS_INLINE_TEXT: 1_024 } }));
  await running.ready();
}

/** The SDK's defaults from its env slice, logging everything. */
function defaultEnv(): SdkEnv {
  return { ...sdkEnv.parse(), HARNESS_LOG_LEVEL: 'debug' };
}

describe('ctx.resources', () => {
  it('reads a resource through the hub, downloading long text by ref, and treats a missing one as absent', async () => {
    const hub = new FakeHub();
    await start(hub);
    const ref = hub.put(new TextEncoder().encode('long body'), 'text/plain');
    hub.onResource = (read) => {
      if (read.uri !== 'doc://a') { return Promise.reject(reject(404, 'NOT_FOUND', 'nope')); }
      const result: ResourceRead = { stat: { uri: read.uri, name: 'a', type: 'file', version: '1' }, text: { ref }, links: [{ raw: './b', kind: 'link' }] };
      return Promise.resolve(result);
    };
    expect(await hub.run('docs/peek', { uri: 'a' })).toEqual({ status: 'done', result: { text: 'long body', links: 1, known: true } });
    expect(await hub.run('docs/peek', { uri: 'gone' })).toEqual({ status: 'done', result: { text: '', links: 0, known: false } });
  });

  it('lists a resource\'s sections through the hub, from the fake hub\'s fixtures', async () => {
    const hub = new FakeHub();
    await start(hub);
    hub.sections.set('doc://a', [{ key: SectionKey.parse('a > intro'), path: ['intro'], title: 'Intro', start: 0, end: 5 }]);
    expect(await hub.run('docs/outline', { uri: 'a' })).toEqual({ status: 'done', result: ['Intro'] });
    expect(await hub.run('docs/outline', { uri: 'none' })).toEqual({ status: 'done', result: [] });
  });

  it('asks the hub for a pairing grant and the fake hub records it', async () => {
    const hub = new FakeHub();
    await start(hub);
    if (running === undefined) { throw new Error('not started'); }
    const subject = InstallSubject.parse({ kind: 'system-install', system: 'notes', instance: 'main', version: '1.0.0', manifestHash: 'm', bundleHash: 'b', sourceHash: 's', host: { system: 'fs', instance: 'main' } });
    const run = hub.runInfo(QualifiedName.parse('fs/install_system')).id;
    const grant = await running.grantPairing({ run, subject });
    expect(grant.token).toMatch(/^pair-/);
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect(hub.pairingGrants).toEqual([{ run, subject, ...grant }]);
  });

  it('says plainly what the link cannot do yet', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(await hub.run('docs/deep', {})).toEqual({ status: 'done', result: 'ok' });
  });
});

describe('serving the hub', () => {
  it('sends long text by ref and serves its chunks when the hub fetches them', async () => {
    const hub = new FakeHub();
    await start(hub);
    const read = await hub.peer().call('read', { uri: 'doc://big', want: ['text'] });
    if (read.text === undefined || !('ref' in read.text)) { throw new Error('expected text by ref'); }
    const { chunk } = await hub.peer().call('content', { ref: read.text.ref, offset: 0, length: read.text.ref.size });
    expect(Buffer.from(chunk, 'base64').toString('utf8')).toBe('é'.repeat(800));
    await expect(hub.peer().call('content', { ref: { ...read.text.ref, hash: '0'.repeat(64) }, offset: 0, length: 1 })).rejects.toThrow();
    expect(await hub.peer().call('list', { uri: 'doc://' })).toEqual({ items: [{ uri: 'doc://', name: 'child', type: 'file', version: '1' }], cursor: 'next' });
  });

  it('cuts a resource into sections with its sectioner, reading it through the hub', async () => {
    const hub = new FakeHub();
    await start(hub);
    hub.onResource = (read) => Promise.resolve({ stat: { uri: read.uri, name: 'n', type: 'file', version: '2' }, text: { inline: 'one\ntwo' } });
    const sections = await hub.peer().call('sections', { sectioner: 'lines', uri: 'doc://n', version: '2' });
    expect(sections.map((s) => s.key)).toEqual(['n > one', 'n > two']);
    await expect(hub.peer().call('sections', { sectioner: 'nope', uri: 'doc://n', version: '2' })).rejects.toThrow();
  });

  it('delivers the hub events it handles, and subscribes to only those', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(hub.manifests[0]?.events).toEqual(['message', 'fns']);
    events.length = 0;
    await hub.peer().call('event', { type: 'message', message: { id: 'msg_1', session: 'ses_1', author: TEST_USER.id, role: 'user', text: 'hi', replyAll: false, createdAt: 0 } });  
    await hub.peer().call('event', { type: 'fns', added: ['docs/peek'], removed: [] });
    await hub.peer().call('event', { type: 'resources', changes: [] });
    expect(events).toEqual(['message:hi', 'fns:docs/peek']);
  });

  it('undoes a fn of its kind with the fn\'s payload and the undo payload', async () => {
    const hub = new FakeHub();
    await start(hub);
    const outcome = await hub.run('other/m', {}, { kind: 'docs/macro', payload: { steps: ['a', 'b'] } });
    expect(outcome).toEqual({ status: 'done', result: 2, undo: { count: 2 } });
    undone.length = 0;
    expect(await hub.peer().call('undo', { run: hub.runInfo('other/m'), fn: 'm', kind: 'docs/macro', fnPayload: { steps: ['a', 'b'] }, payload: { count: 2 } })).toEqual({ status: 'undone', summary: 'reverted' });
    expect(undone).toEqual(['a,b:{"count":2}']);
    expect(await hub.peer().call('undo', { run: hub.runInfo('docs/peek'), fn: 'peek', kind: 'native', payload: {} })).toEqual({ status: 'gone' });
    expect((await hub.peer().call('undo', { run: hub.runInfo('docs/x'), fn: 'x', kind: 'native', payload: {} })).status).toBe('failed');
  });

  it('refuses what it does not have', async () => {
    const hub = new FakeHub();
    await start(hub);
    const peer = hub.peer();
    await expect(peer.call('check', { kind: 'none', payload: {} })).rejects.toThrow();
    expect(await peer.call('check', { kind: 'macro', payload: { steps: 3 } })).toMatchObject({ problems: [expect.any(String)] });
    expect(await peer.call('control', { run: 'run_none', action: 'cancel' })).toMatchObject({ accepted: false });  
    await expect(peer.call('form', { delivery: 'dlv_1', run: 'run_none', value: {} })).rejects.toThrow();  
    await vi.waitFor(() => { expect(running?.status).toBe('connected'); });
  });
});
