import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type LogRecord } from '@ayepi/log';
import { LinkLimits, mintId, type OutcomeWire } from '@harness/core';
import { afterAll, describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { readClientBundle, uploadClientBundle } from './assets.ts';
import { HubContent, LocalContent, rawChunkSize } from './content.ts';
import { fileUri, mimeOf, NodeFiles } from './files.ts';
import { FileJournal, MemoryJournal } from './journal.ts';
import { FileKeyStore, MemoryKeyStore, verifyNonce } from './keys.ts';
import type { HubAccess, HubLink } from './link.ts';
import { httpBase } from './link.ts';
import { jsonFields, ScopedLog } from './log.ts';
import { ManifestState } from './manifest-state.ts';
import { ConfigStore } from './runtime.ts';
import { LinkState, StateConflict } from './state.ts';
import { implTable, SystemTable, splitMethod } from './table.ts';
import { decode, encode, fnError, settledOf, thrownError } from './wire.ts';
import { CallFailed } from '../ctx.ts';

const folders: string[] = [];
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'harness-sdk-'));
  folders.push(made);
  return made;
}
afterAll(async () => { await Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))); });

/**
 * A hub link whose `call` answers from a table of handlers. Only the endpoints a test uses are given; the rest throw.
 * The typed `ApiClient` is built from this one function, which is the whole of what the runtime uses.
 */
function hubOf(answer: (name: string, data: unknown) => unknown): HubAccess {
  const hub = { call: (name: string, data: unknown) => Promise.resolve(answer(name, data)) };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the runtime only ever uses `call`; this test double answers it
  const link = hub as unknown as HubLink;
  return { ready: () => Promise.resolve(link), now: () => link, limits: () => LinkLimits.parse({ maxFrame: 4_096, maxChunk: 4_096, heartbeat: 1_000 }) };
}

describe('keys', () => {
  it('signs a nonce the hub can verify with the public key', async () => {
    const keys = new MemoryKeyStore();
    const signature = await keys.sign('nonce-1');
    expect(verifyNonce(await keys.publicKey(), 'nonce-1', signature)).toBe(true);
    expect(verifyNonce(await keys.publicKey(), 'nonce-2', signature)).toBe(false);
  });

  it('keeps the pair in the state folder, so a restart proves the same key', async () => {
    const state = await folder();
    const first = await new FileKeyStore(state).publicKey();
    expect(await new FileKeyStore(state).publicKey()).toBe(first);
    expect(JSON.parse(await readFile(join(state, 'key.json'), 'utf8'))).toHaveProperty('privateKey');
  });
});

describe('journal', () => {
  const done: OutcomeWire = { status: 'done', result: 1 };

  it('remembers outcomes, keeping only the newest', async () => {
    const journal = new MemoryJournal(2);
    const [a, b, c] = [mintId('run'), mintId('run'), mintId('run')];
    await journal.put(a, done);
    await journal.put(b, done);
    await journal.put(c, done);
    expect(await journal.get(a)).toBeUndefined();
    expect(await journal.get(c)).toEqual(done);
  });

  it('survives a restart in its file, skipping a torn line', async () => {
    const state = await folder();
    const run = mintId('run');
    await new FileJournal(state, 10).put(run, done);
    await writeFile(join(state, 'journal.jsonl'), `${await readFile(join(state, 'journal.jsonl'), 'utf8')}{"run":`, 'utf8');
    expect(await new FileJournal(state, 10).get(run)).toEqual(done);
  });

  it('rewrites the file to the newest entries when it grows past its size', async () => {
    const state = await folder();
    const journal = new FileJournal(state, 2);
    for (let i = 0; i < 5; i += 1) { await journal.put(mintId('run'), { status: 'done', result: i }); }
    expect((await readFile(join(state, 'journal.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });
});

describe('content', () => {
  it('uploads in chunks no bigger than the hub allows and downloads by ref with the hash checked', async () => {
    const store = new Map<string, Uint8Array[]>();
    const chunks: number[] = [];
    let held = new Uint8Array();
    const hub = hubOf((name, data) => {
      if (name === 'upload') {
        const body = data as { upload: string; chunk: string; last: boolean; mime: string }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- the upload body
        chunks.push(body.chunk.length);
        const parts = store.get(body.upload) ?? [];
        parts.push(new Uint8Array(Buffer.from(body.chunk, 'base64')));
        store.set(body.upload, parts);
        if (!body.last) { return {}; }
        held = new Uint8Array(Buffer.concat(parts));
        return { ref: new LocalContent(1e9).put(held, body.mime) };
      }
      const body = data as { offset: number; length: number }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- the content body
      return { chunk: Buffer.from(held.subarray(body.offset, body.offset + body.length)).toString('base64') };
    });
    const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
    const content = new HubContent(hub);
    const ref = await content.upload(bytes, 'application/octet-stream');
    expect(Math.max(...chunks)).toBeLessThanOrEqual(4_096);
    expect(ref.size).toBe(10_000);
    expect(await content.download(ref)).toEqual(bytes);
    expect(rawChunkSize(4_096)).toBe(3_072);
  });

  it('holds content for the hub within a byte budget, dropping the oldest', () => {
    const local = new LocalContent(10);
    const a = local.put(new Uint8Array(6), 'x/a');
    const b = local.put(new Uint8Array(6).fill(1), 'x/b');
    expect(local.chunk(a, 0, 6)).toBeUndefined();
    expect(local.chunk(b, 0, 2)).toBe(Buffer.from([1, 1]).toString('base64'));
  });
});

describe('session state', () => {
  const owner = { run: mintId('run') };
  const type = g.obj({ cwd: g.text(), count: g.num() });

  it('reads only declared fields, checked, and writes encoded patches', async () => {
    const writes: unknown[] = [];
    const hub = hubOf((name, data) => {
      if (name === 'stateGet') { return { values: { cwd: '/a', other: 1 }, version: 3 }; }
      writes.push(data);
      return { version: 4 };
    });
    const state = new LinkState(hub, owner, type, { retries: 3 });
    expect(await state.get()).toEqual({ cwd: '/a' });
    await state.set({ count: 2 });
    await state.clear('cwd');
    expect(writes).toEqual([{ owner, patch: { count: 2 }, clear: [] }, { owner, patch: {}, clear: ['cwd'] }]);
    await expect(state.set({ count: 'x' as unknown as number })).rejects.toThrow(); // eslint-disable-line @typescript-eslint/consistent-type-assertions -- a wrong value on purpose
  });

  it('retries an update when another write got in first, then gives up', async () => {
    let version = 0;
    let conflicts = 2;
    const hub = hubOf((name) => {
      if (name === 'stateGet') { return { values: { count: version }, version }; }
      if (conflicts > 0) { conflicts -= 1; version += 1; return { conflict: true }; }
      return { version: version + 1 };
    });
    const state = new LinkState(hub, owner, type, { retries: 5 });
    await state.update((s) => ({ count: (s.count ?? 0) + 1 }));
    expect(conflicts).toBe(0);
    const stuck = new LinkState(hubOf((name) => (name === 'stateGet' ? { values: {}, version: 0 } : { conflict: true })), owner, type, { retries: 2 });
    await expect(stuck.update(() => ({ count: 1 }))).rejects.toBeInstanceOf(StateConflict);
  });
});

describe('config', () => {
  it('keeps the versions a run may still use and checks every value', () => {
    const store = new ConfigStore(g.obj({ folder: g.text() }), 2);
    expect(store.current).toBeUndefined();
    store.apply({ value: { folder: '/a' }, version: 1 });
    store.apply({ value: { folder: '/b' }, version: 2 });
    store.apply({ value: { folder: '/c' }, version: 3 });
    expect(store.at(1)).toBeUndefined();
    expect(store.at(2)).toEqual({ value: { folder: '/b' } });
    expect(store.current).toEqual({ version: 3, value: { folder: '/c' } });
    expect(() => store.apply({ value: { folder: 1 }, version: 4 })).toThrow();
    expect(store.check({ nope: true })).toBeUndefined();
  });

  it('is usable at once when the contract needs no config', () => {
    expect(new ConfigStore(g.obj({}), 2).current).toEqual({ version: 0, value: {} });
  });
});

describe('wire', () => {
  it('decodes and encodes against gin types, naming what did not fit', () => {
    expect(decode(g.obj({ at: g.timestamp() }), { at: '2026-01-01T00:00:00.000Z' }, 'x')).toEqual({ ok: true, value: { at: new Date('2026-01-01T00:00:00.000Z') } });
    const refused = decode(g.num(), 'x', 'The count');
    expect(refused).toMatchObject({ ok: false, error: { class: 'caller' } });
    expect(refused.ok ? '' : refused.error.message).toContain('The count');
    expect(encode(g.num(), 'x' as unknown as number, 'The result')).toMatchObject({ ok: false, error: { class: 'fatal' } }); // eslint-disable-line @typescript-eslint/consistent-type-assertions -- a wrong value on purpose
  });

  it('turns settlements and thrown errors into what a run reports', () => {
    expect(settledOf(g.num(), { status: 'done', result: 1 }, 'r')).toEqual({ status: 'done', result: 1 });
    expect(settledOf(g.num(), { status: 'done', result: 'x' }, 'r').status).toBe('failed');
    expect(settledOf(g.num(), { status: 'background', run: mintId('run') }, 'r')).toMatchObject({ status: 'failed', error: { code: 'background' } });
    expect(thrownError(new CallFailed(undefined, { class: 'cancelled' }))).toMatchObject({ class: 'fatal', code: 'dep-cancelled' });
    expect(thrownError(new CallFailed(undefined, fnError('caller', 'nope')))).toEqual({ class: 'caller', message: 'nope' });
    expect(thrownError('weird')).toMatchObject({ class: 'fatal', code: 'threw', message: 'weird' });
  });

  it('turns a link URL into its HTTP base', () => {
    expect(httpBase('ws://hub:4300/link')).toBe('http://hub:4300');
    expect(httpBase('wss://hub.example.com/link')).toBe('https://hub.example.com');
  });
});

describe('logging', () => {
  it('adds fixed fields to every line and keeps fields JSON', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'debug', transports: [{ name: 'mem', write: (record) => { records.push(record); } }] });
    const log = new ScopedLog(logger, { system: 'notes' }).with({ run: 'run_1' });
    log.info('run.started', { fn: 'notes/a' });
    log.error('run.threw', {}, new Error('boom'));
    expect(records[0]).toMatchObject({ msg: 'run.started', system: 'notes', run: 'run_1', fn: 'notes/a' });
    expect(records[1]?.error?.message).toBe('boom');
    expect(jsonFields({ a: 1, b: undefined, c: new Date(0), d: () => 1 })).toEqual({ a: 1, c: '1970-01-01T00:00:00.000Z' });
  });
});

describe('files', () => {
  it('reads, writes, lists and removes relative to its base, and shares through the hub', async () => {
    const base = await folder();
    const uploads: string[] = [];
    const content = {
      upload: (bytes: Uint8Array, mime: string) => { uploads.push(mime); return Promise.resolve(new LocalContent(1e6).put(bytes, mime)); },
      download: () => Promise.reject(new Error('unused')),
    };
    const files = NodeFiles.at(base)({ content, signal: new AbortController().signal });
    await files.write('a/b.md', '# hi');
    expect(await files.readText('a/b.md')).toBe('# hi');
    expect((await files.list('a')).map((s) => [s.name, s.type, s.mime])).toEqual([['b.md', 'file', 'text/markdown']]);
    expect((await files.share('a/b.md')).size).toBe(4);
    expect(uploads).toEqual(['text/markdown']);
    await files.remove('a');
    await expect(files.list('a')).rejects.toThrow();
    expect(mimeOf('x.unknown')).toBe('application/octet-stream');
    expect(fileUri(join(base, 'x')).startsWith('file:///')).toBe(true);
  });
});

describe('client assets', () => {
  it('lists every built file with its hash and uploads each', async () => {
    const out = await folder();
    await mkdir(join(out, 'chunks'));
    await writeFile(join(out, 'index.js'), 'export default 1;');
    await writeFile(join(out, 'chunks', 'a.js'), 'export const a = 1;');
    const bundle = await readClientBundle(out);
    expect(bundle.assets.files.map((f) => f.path)).toEqual(['chunks/a.js', 'index.js']);
    expect(bundle.assets.hash).toMatch(/^[0-9a-f]{64}$/);
    const uploaded: string[] = [];
    await uploadClientBundle(bundle, { upload: (_b, mime) => { uploaded.push(mime); return Promise.resolve(new LocalContent(1e6).put(_b, mime)); }, download: () => Promise.reject(new Error('unused')) });
    expect(uploaded).toEqual(['text/javascript', 'text/javascript']);
    await expect(readClientBundle(await folder())).rejects.toThrow(/index\.js/);
  });
});

describe('the manifest as it is now', () => {
  const tools = system('tools', { description: 'Tools.' }).with({ fns: { a: fn({ description: 'A.', args: g.obj({}), returns: g.text() }) } });

  it('includes fns added at runtime, and a change changes the hash', async () => {
    const table = new SystemTable(tools, implTable<typeof tools.defs>({ fns: { a: { async run(_x, ctx) { return ctx.done('a'); } } } }));
    const state = new ManifestState(table, { version: '1' });
    const before = await state.hash();
    const other = system('other', { description: 'O.' }).with({ fns: { b: fn({ description: 'B.', args: g.obj({}), returns: g.text() }) } });
    table.add('extra', fn({ description: 'Extra.', args: g.obj({}), returns: g.text(), deps: { b: other.fns.b } }), undefined);
    const after = await state.current();
    expect(after.hash).not.toBe(before);
    expect(after.fns.map((f) => f.name)).toEqual(['a', 'extra']);
    expect(after.requires).toEqual(['other']);
    expect((await state.upsert('extra', fn({ description: 'E.', args: g.obj({}), returns: g.text() }))).upsert.fns?.[0]?.name).toBe('extra');
    expect((await state.remove('extra')).remove).toEqual({ fns: ['extra'] });
    expect(() => { table.add('a', fn({ description: 'dup', args: g.obj({}), returns: g.text() }), undefined); }).toThrow();
    expect(splitMethod('Entry.reveal')).toEqual({ type: 'Entry', method: 'reveal' });
  });
});
