/**
 * The MCP face's resources and prompts: a system's roots, children, reads and watches as MCP resources, and its
 * `/commands` as MCP prompts, checked end to end with `@ayepi/mcp`'s client over Streamable HTTP.
 */
import { McpClient, McpError, McpHttpClientTransport, type McpNotice, type McpResourceSource } from '@ayepi/mcp';
import type { ResourceChange, ResourceRoot, ResourceStat, ResourceUri } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { arg, context } from '../declare.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import type { ResourceProvider } from '../resources.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { McpPrompts } from './mcp-prompts.ts';
import { McpResources } from './mcp-resources.ts';
import { FakeHub } from './testing.ts';

/** A port for this test's MCP server (above 4300, as the repo asks). */
const PORT = 4389;
const URL_ = `http://127.0.0.1:${PORT}/`;
const CLIENT = { clientInfo: { name: 'test', version: '1' } } as const;

const notes = system('notes', { description: 'Notes.' }).with({
  fns: { count: fn({ description: 'Count notes.', args: g.obj({}), returns: g.num() }) },
  context: {
    style: context({ description: 'How to write a note.', content: 'Write about {{topic}} for {{ who }}. Keep {{other}}.', command: { name: 'style', args: { topic: arg('What it is about.'), who: arg('Who reads it.', { required: false }) } } }),
    today: context({ description: 'Notes from today.', command: { name: 'today', args: {} } }),
    always: context({ description: 'Not a command.', content: 'Always.' }),
  },
});

/** A stat for a note. */
function stat(uri: ResourceUri, type: ResourceStat['type'] = 'file', mime?: string): ResourceStat {
  return { uri, name: uri.slice(uri.lastIndexOf('/') + 1), type, version: '1', ...(mime === undefined ? {} : { mime, size: 3 }) };
}

/** Notes in memory under two roots, the first listed two to a page. */
class Notes implements ResourceProvider {
  readonly hub: FakeHub;
  readonly changes = new Set<(changes: ResourceChange[]) => void>();

  constructor(hub: FakeHub) {
    this.hub = hub;
  }

  async roots(): Promise<ResourceRoot[]> {
    return [
      { uri: 'notes://all/', name: 'All', description: 'Every note.', index: 'all', ignore: [], watch: true },
      { uri: 'notes://old', name: 'Old', description: 'Old notes.', index: 'none', ignore: [], watch: false },
    ];
  }

  async list(uri: ResourceUri, cursor?: string) {
    if (uri === 'notes://old') { return { items: [stat('notes://old/x.txt', 'file', 'text/plain'), stat('notes://old/rec', 'record')] }; }
    const all = [stat('notes://all/a.md', 'file', 'text/markdown'), stat('notes://all/pic.png', 'file', 'image/png'), stat('notes://all/sub', 'folder')];
    const from = Number(cursor ?? '0');
    return { items: all.slice(from, from + 2), ...(from + 2 < all.length ? { cursor: String(from + 2) } : {}) };
  }

  async stat(uri: ResourceUri) {
    return uri.endsWith('missing') ? undefined : stat(uri);
  }

  async read(uri: ResourceUri) {
    const at = stat(uri, 'file', uri.endsWith('.png') ? 'image/png' : 'text/plain');
    if (uri.endsWith('.png')) { return { stat: at, bytes: this.hub.put(new Uint8Array([1, 2, 3]), 'image/png') }; }
    if (uri.endsWith('long')) { return { stat: at, text: { ref: this.hub.put(new TextEncoder().encode('long text'), 'text/plain') } }; }
    if (uri.endsWith('doc')) { return { stat: stat(uri, 'file', 'application/pdf'), text: { inline: '# Doc' } }; }
    if (uri.endsWith('empty')) { return { stat: at }; }
    return { stat: at, text: { inline: `text of ${uri}` } };
  }

  watch(_uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void {
    this.changes.add(onChange);
    return () => { this.changes.delete(onChange); };
  }

  /** Report a change to every watch. */
  change(uri: ResourceUri): void {
    for (const listener of this.changes) { listener([{ uri, change: 'changed' }]); }
  }
}

let running: RunningSystem<'notes'> | undefined;
let client: McpClient | undefined;
afterEach(async () => {
  await client?.close();
  await running?.stop();
  client = undefined;
  running = undefined;
});

async function start(): Promise<{ provider: Notes; client: McpClient }> {
  const hub = new FakeHub();
  const provider = new Notes(hub);
  running = await serve(notes, {
    fns: { count: { async run(_a, ctx) { return ctx.done(2); } } },
    context: { today: async (_args, ctx) => `notes for ${ctx.user.name} on ${ctx.time.timeZone}` },
    resources: provider,
  }, { hub: 'ws://hub.test/link', state: 'x', version: '1.0.0', mcp: { http: { port: PORT } } }, hub.host());
  await running.ready();
  client = await McpClient.connect(new McpHttpClientTransport(URL_), CLIENT);
  return { provider, client };
}

describe('the MCP face: resources and prompts', () => {
  it('advertises tools, resources with subscriptions, and prompts', async () => {
    const { client: mcp } = await start();
    expect(mcp.server.capabilities).toEqual({ tools: { listChanged: true }, resources: { subscribe: true, listChanged: false }, prompts: { listChanged: false } });
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(['notes_count']);
  });

  it('lists roots, then each root\'s children page by page, and offers a template per root', async () => {
    const { client: mcp } = await start();
    expect(await mcp.listResources()).toEqual([
      { uri: 'notes://all/', name: 'All', description: 'Every note.', mimeType: 'inode/directory' },
      { uri: 'notes://old', name: 'Old', description: 'Old notes.', mimeType: 'inode/directory' },
      { uri: 'notes://all/a.md', name: 'a.md', mimeType: 'text/markdown', size: 3 },
      { uri: 'notes://all/pic.png', name: 'pic.png', mimeType: 'image/png', size: 3 },
      { uri: 'notes://all/sub', name: 'sub', mimeType: 'inode/directory' },
      { uri: 'notes://old/x.txt', name: 'x.txt', mimeType: 'text/plain', size: 3 },
      { uri: 'notes://old/rec', name: 'rec' },
    ]);
    expect(await mcp.listResourceTemplates()).toEqual([
      { uriTemplate: 'notes://all/{+path}', name: 'All', description: 'Every note. Any path under All.' },
      { uriTemplate: 'notes://old/{+path}', name: 'Old', description: 'Old notes. Any path under Old.' },
    ]);
  });

  it('reads text inline or by ref, bytes as base64, and answers -32002 for what is not there', async () => {
    const { client: mcp } = await start();
    expect(await mcp.readResource('notes://all/a.md')).toEqual([{ uri: 'notes://all/a.md', mimeType: 'text/plain', text: 'text of notes://all/a.md' }]);
    expect(await mcp.readResource('notes://all/long')).toEqual([{ uri: 'notes://all/long', mimeType: 'text/plain', text: 'long text' }]);
    expect(await mcp.readResource('notes://all/doc')).toEqual([{ uri: 'notes://all/doc', mimeType: 'text/markdown', text: '# Doc' }]);
    expect(await mcp.readResource('notes://all/pic.png')).toEqual([{ uri: 'notes://all/pic.png', mimeType: 'image/png', blob: 'AQID' }]);
    expect(await mcp.readResource('notes://all/empty')).toEqual([]);
    await expect(mcp.readResource('notes://all/missing')).rejects.toMatchObject({ code: -32002 });
    await expect(mcp.readResource('not a uri')).rejects.toMatchObject({ code: -32002 });
  });

  it('tells a subscribed client when the resource or anything under it changes', async () => {
    const { provider, client: mcp } = await start();
    const heard: McpNotice[] = [];
    mcp.onNotification((notice) => { heard.push(notice); });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await mcp.subscribe('notes://all/');
    provider.change('notes://elsewhere/z');
    provider.change('notes://all/sub/deep.md');
    provider.change('notes://all');
    await expect.poll(() => heard.length).toBe(2);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(heard).toHaveLength(2);
    expect(heard[0]).toEqual({ method: 'notifications/resources/updated', params: { uri: 'notes://all/' } });
    await mcp.unsubscribe('notes://all/');
    expect(provider.changes.size).toBe(0);
  });

  it('offers each command as a prompt, filled as the hub would fill it', async () => {
    const { client: mcp } = await start();
    expect(await mcp.listPrompts()).toEqual([
      { name: 'style', description: 'How to write a note.', arguments: [{ name: 'topic', description: 'What it is about.', required: true }, { name: 'who', description: 'Who reads it.', required: false }] },
      { name: 'today', description: 'Notes from today.' },
    ]);
    expect(await mcp.getPrompt('style', { topic: 'cats', who: 'kids' })).toEqual({
      description: 'How to write a note.',
      messages: [{ role: 'user', content: { type: 'text', text: 'Write about cats for kids. Keep {{other}}.' } }],
    });
    expect((await mcp.getPrompt('style', { topic: 'dogs' })).messages[0]?.content).toEqual({ type: 'text', text: 'Write about dogs for . Keep {{other}}.' });
    expect((await mcp.getPrompt('today')).messages[0]?.content).toEqual({ type: 'text', text: 'notes for MCP client on UTC' });
    const missing = await mcp.getPrompt('style').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(McpError);
    expect(missing).toMatchObject({ code: -32602, message: 'prompt "style" needs topic' });
    await expect(mcp.getPrompt('always')).rejects.toMatchObject({ code: -32602 });
  });
});

describe('McpResources', () => {
  const content = { upload: () => Promise.reject(new Error('unused')), download: () => Promise.reject(new Error('unused')) };
  const provider: ResourceProvider = {
    roots: async () => [],
    list: async () => ({ items: [] }),
    stat: async () => undefined,
    read: () => Promise.reject(new Error('unused')),
  };

  it('offers no subscriptions for a provider that cannot watch, and no roots as an empty listing', async () => {
    const resources: McpResourceSource = McpResources.of(provider, content);
    expect('watch' in resources).toBe(false);
    expect(await resources.list(undefined, new AbortController().signal)).toEqual({ resources: [] });
  });

  it('refuses a cursor it did not give', async () => {
    await expect(McpResources.of(provider, content).list('bogus')).rejects.toThrow('"bogus" is not a cursor this server gave.');
  });

  it('watches nothing for a URI that is not one', () => {
    let watched = 0;
    const resources: McpResourceSource = McpResources.of({ ...provider, watch: () => { watched += 1; return () => undefined; } }, content);
    const stop = resources.watch?.('nope', () => undefined);
    expect(stop).toBeTypeOf('function');
    stop?.();
    expect(watched).toBe(0);
  });
});

describe('McpPrompts', () => {
  it('fills no prompt it does not offer', async () => {
    const prompts = new McpPrompts(notes.defs.context, { contextText: () => Promise.reject(new Error('unused')) }, () => { throw new Error('unused'); });
    expect(prompts.empty).toBe(false);
    expect(await prompts.get('always', {}, new AbortController().signal)).toBeUndefined();
  });
});
