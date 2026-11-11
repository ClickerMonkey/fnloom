import { createHash } from 'node:crypto';
import { ApiError } from '@ayepi/core';
import { ActorId, ContentRef, IDS, MAIN_INSTANCE, QualifiedName, SessionId, SystemName, type DeliveryRecord, type Json, type LinkSession, type TypeRecord } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRun } from '../chat/testing.ts';
import { openTestStore } from '../store/fixtures.ts';
import type { SqliteStore } from '../store/sqlite.ts';
import { linkPayload } from '../testing.ts';
import { ChunkedUploads, LinkServices, linkServiceHandlers, type LinkServiceDeps } from './services.ts';

const FS: LinkSession = { system: SystemName.parse('fs'), instance: MAIN_INSTANCE, boot: 'i1' };
const SHOP: LinkSession = { system: SystemName.parse('shop'), instance: MAIN_INSTANCE, boot: 'i2' };
const ADA = ActorId.parse('act_ada');
const RUN = IDS.run.parse('run_one');
const ref = (hash: string, size: number): ContentRef => ContentRef.parse({ hash: hash.padEnd(64, '0'), size, mime: 'text/plain' });

/** Stored bytes, by hash. */
class FakeContent {
  readonly stored = new Map<string, Uint8Array>();
  put(bytes: Uint8Array, mime: string): Promise<ContentRef> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.stored.set(hash, bytes);
    return Promise.resolve(ContentRef.parse({ hash, size: bytes.length, mime }));
  }
  has(given: ContentRef): Promise<boolean> {
    return Promise.resolve(this.stored.has(given.hash));
  }
  read(given: ContentRef, offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve((this.stored.get(given.hash) ?? new Uint8Array()).slice(offset, offset + length));
  }
}

let store: SqliteStore | undefined;
afterEach(async () => { await store?.close(); store = undefined; });

/** Services over a real in-memory store, with fakes for the rest; returns what they recorded. */
async function services(overrides: Partial<LinkServiceDeps> = {}) {
  const opened = await openTestStore();
  store = opened;
  const content = new FakeContent();
  const attached: Array<{ run: string; part: unknown }> = [];
  const state: Array<{ op: string; owner: unknown; input?: unknown }> = [];
  let now = 1_000;
  const types: Record<string, TypeRecord> = {};
  const deps: LinkServiceDeps = {
    store: () => opened,
    content: () => content,
    catalog: () => ({
      attachment: (name) => Promise.resolve(name === 'fs/diff' ? { name: 'diff', description: 'A diff.', data: { name: 'obj', props: {} } } : undefined),
      check: (_system, _type, value: Json) => Promise.resolve(typeof value === 'object' && value !== null ? [] : ['not an object']),
      typeClosure: (names) => Promise.resolve({ order: names.filter((n) => n in types), missing: names.filter((n) => !(n in types)) }),
      type: (name) => Promise.resolve(types[name]),
    }),
    state: () => ({
      get: (owner) => { state.push({ op: 'get', owner }); return Promise.resolve({ values: { cwd: '/x' }, version: 3 }); },
      set: (owner, input) => { state.push({ op: 'set', owner, input }); return Promise.resolve({ version: 4 }); },
    }),
    turns: () => ({ attach: (run, part) => { attached.push({ run, part }); return Promise.resolve(); } }),
    maxUpload: 10,
    uploadTtl: 1_000,
    clock: () => now,
    ...overrides,
  };
  await opened.table('runs').insert(makeRun({ id: RUN, fn: 'fs/bash', turn: IDS.turn.parse('trn_one'), actor: ADA }));
  return { services: new LinkServices(deps), store: opened, content, attached, state, types, advance: (ms: number) => { now += ms; } };
}

describe('uploads in chunks', () => {
  it('stores the bytes once the last chunk arrives, and keeps two systems\' uploads apart', async () => {
    const { services: s, content } = await services();
    expect(await s.upload(FS, { upload: 'u', chunk: Buffer.from('he').toString('base64'), last: false, mime: 'text/plain' })).toEqual({});
    await s.upload(SHOP, { upload: 'u', chunk: Buffer.from('zz').toString('base64'), last: false, mime: 'text/plain' });
    const done = await s.upload(FS, { upload: 'u', chunk: Buffer.from('llo').toString('base64'), last: true, mime: 'text/plain' });
    expect(done.ref?.size).toBe(5);
    expect(new TextDecoder().decode(content.stored.get(done.ref?.hash ?? ''))).toBe('hello');
  });

  it('refuses an upload over the limit and forgets ones left unfinished too long', async () => {
    const { content } = await services();
    let now = 0;
    const uploads = new ChunkedUploads({ content: () => content, maxUpload: 4, uploadTtl: 100, clock: () => now });
    await expect(uploads.add(FS, { upload: 'big', chunk: Buffer.from('12345').toString('base64'), last: true, mime: 'x' })).rejects.toMatchObject({ status: 413 });
    await uploads.add(FS, { upload: 'slow', chunk: Buffer.from('ab').toString('base64'), last: false, mime: 'x' });
    expect(uploads.size).toBe(1);
    now = 500;
    await uploads.add(FS, { upload: 'other', chunk: Buffer.from('c').toString('base64'), last: false, mime: 'x' });
    expect(uploads.size).toBe(1);
  });
});

describe('content', () => {
  it('reads a slice back in base64, and 404s for content it doesn\'t have', async () => {
    const { services: s, content } = await services();
    const stored = await content.put(new TextEncoder().encode('abcdef'), 'text/plain');
    expect(await s.content({ ref: stored, offset: 2, length: 3 })).toEqual({ chunk: Buffer.from('cde').toString('base64') });
    await expect(s.content({ ref: ref('ab', 1), offset: 0, length: 1 })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('state, settings and attachments for a system\'s own runs', () => {
  it('reads and writes state only for runs the asking system ran', async () => {
    const { services: s, state } = await services();
    expect(await s.stateGet(FS, { run: RUN })).toEqual({ values: { cwd: '/x' }, version: 3 });
    expect(await s.stateSet(FS, { run: RUN }, { patch: { cwd: '/y' }, clear: [] })).toEqual({ version: 4 });
    await expect(s.stateGet(SHOP, { run: RUN })).rejects.toMatchObject({ status: 403 });
    await expect(s.stateGet(FS, { delivery: IDS.delivery.parse('dlv_none') })).rejects.toMatchObject({ status: 404 });
    expect(state.map((e) => e.op)).toEqual(['get', 'set']);
  });

  it('reads and writes state only for deliveries that went to the asking system', async () => {
    const { services: s, store: db, state } = await services();
    const delivery = (id: string, system: LinkSession['system']): DeliveryRecord => ({
      id: IDS.delivery.parse(id), system, kind: { action: 'echo', input: {} }, session: SessionId.parse('ses_one'), actor: ADA, status: 'delivered', attempts: 1, createdAt: 0,
    });
    const mine = await db.table('deliveries').insert(delivery('dlv_fs', FS.system));
    const theirs = await db.table('deliveries').insert(delivery('dlv_shop', SHOP.system));
    expect(await s.stateGet(FS, { delivery: mine.id })).toEqual({ values: { cwd: '/x' }, version: 3 });
    expect(await s.stateSet(FS, { delivery: mine.id }, { patch: { cwd: '/y' }, clear: [] })).toEqual({ version: 4 });
    await expect(s.stateGet(FS, { delivery: theirs.id })).rejects.toMatchObject({ status: 403, code: 'NOT_YOUR_DELIVERY' });
    await expect(s.stateSet(FS, { delivery: theirs.id }, { patch: { cwd: '/z' }, clear: [] })).rejects.toMatchObject({ status: 403, code: 'NOT_YOUR_DELIVERY' });
    await expect(s.stateGet(SHOP, { delivery: mine.id })).rejects.toMatchObject({ status: 403, code: 'NOT_YOUR_DELIVERY' });
    await expect(s.stateSet(FS, { delivery: IDS.delivery.parse('dlv_none') }, { patch: {}, clear: [] })).rejects.toMatchObject({ status: 404, code: 'DELIVERY_NOT_FOUND' });
    // only the asking system's own delivery reached the state service
    expect(state).toEqual([{ op: 'get', owner: { delivery: mine.id } }, { op: 'set', owner: { delivery: mine.id }, input: { patch: { cwd: '/y' }, clear: [] } }]);
  });

  it('answers a setting with the person\'s own value, else their group\'s', async () => {
    const { services: s, store: db } = await services();
    const setting = QualifiedName.parse('fs/shell');
    expect(await s.setting(FS, { run: RUN, setting })).toEqual({});
    const group = ActorId.parse('act_team');
    await db.table('memberships').insert({ group, user: ADA, addedBy: ADA, addedAt: 0 });
    await db.table('actorSettings').put({ setting, actor: group, value: { allow: ['ls'] }, setBy: ADA, updatedAt: 0 });
    expect(await s.setting(FS, { run: RUN, setting })).toEqual({ value: { allow: ['ls'] } });
    await db.table('actorSettings').put({ setting, actor: ADA, value: { allow: ['git'] }, setBy: ADA, updatedAt: 0 });
    expect(await s.setting(FS, { run: RUN, setting })).toEqual({ value: { allow: ['git'] } });
  });

  it('attaches links as they are and system attachments once their data fits', async () => {
    const { services: s, attached } = await services();
    await s.attach(FS, { run: RUN, item: { link: { url: 'https://example.com', title: 'x' } } });
    await s.attach(FS, { run: RUN, item: { attachment: QualifiedName.parse('fs/diff'), data: { path: 'a' }, title: 'a' } });
    await expect(s.attach(FS, { run: RUN, item: { attachment: QualifiedName.parse('fs/diff'), data: 'nope', title: 'a' } })).rejects.toMatchObject({ status: 400 });
    await expect(s.attach(FS, { run: RUN, item: { attachment: QualifiedName.parse('fs/none'), data: {}, title: 'a' } })).rejects.toMatchObject({ status: 404 });
    expect(attached.map((a) => a.part)).toEqual([
      { type: 'link', link: { url: 'https://example.com', title: 'x' } },
      { type: 'attachment', attachment: 'fs/diff', data: { path: 'a' }, title: 'a' },
    ]);
  });
});

describe('the link handlers', () => {
  it('hands each endpoint\'s body to its service as the asking system', async () => {
    const { services: s, state, attached, types, content } = await services();
    const handlers = linkServiceHandlers(s);
    const cwd = { cwd: '/y' };
    expect(await handlers.stateGet(linkPayload({ owner: { run: RUN } }, FS))).toEqual({ values: { cwd: '/x' }, version: 3 });
    expect(await handlers.stateSet(linkPayload({ owner: { run: RUN }, patch: cwd, clear: ['old'], version: 3 }, FS))).toEqual({ version: 4 });
    expect(await handlers.stateSet(linkPayload({ owner: { run: RUN }, patch: cwd, clear: [] }, FS))).toEqual({ version: 4 });
    await expect(handlers.stateGet(linkPayload({ owner: { run: RUN } }, SHOP))).rejects.toMatchObject({ status: 403 });
    expect(state).toEqual([
      { op: 'get', owner: { run: RUN } },
      { op: 'set', owner: { run: RUN }, input: { patch: cwd, clear: ['old'], version: 3 } },
      { op: 'set', owner: { run: RUN }, input: { patch: cwd, clear: [] } },
    ]);
    expect(await handlers.setting(linkPayload({ run: RUN, setting: QualifiedName.parse('fs/shell') }, FS))).toEqual({});
    await handlers.attach(linkPayload({ run: RUN, item: { link: { url: 'https://example.com', title: 'x' } } }, FS));
    expect(attached).toEqual([{ run: RUN, part: { type: 'link', link: { url: 'https://example.com', title: 'x' } } }]);
    const uploaded = await handlers.upload(linkPayload({ upload: 'u', chunk: Buffer.from('hi').toString('base64'), last: true, mime: 'text/plain' }, FS));
    expect(uploaded.ref?.size).toBe(2);
    expect(content.stored.size).toBe(1);
    if (uploaded.ref === undefined) { throw new Error('no upload'); }
    expect(await handlers.content(linkPayload({ ref: uploaded.ref, offset: 0, length: 2 }, SHOP))).toEqual({ chunk: Buffer.from('hi').toString('base64') });
    types['shop/Price'] = {
      name: QualifiedName.parse('shop/Price'), system: SystemName.parse('shop'), description: '', def: { name: 'obj', props: {} }, display: { label: 'Price' }, references: [], updatedAt: 0,
    };
    const found = await handlers.types(linkPayload({ names: [QualifiedName.parse('shop/Price'), QualifiedName.parse('shop/Gone')] }, FS));
    expect(found.types.map((t) => t.name)).toEqual(['shop/Price']);
    expect(found.missing).toEqual(['shop/Gone']);
  });
});

describe('named types', () => {
  it('returns the definitions in dependency order with the names it doesn\'t know', async () => {
    const { services: s, types } = await services();
    const record = (name: string): TypeRecord => ({
      name: QualifiedName.parse(name), system: SystemName.parse('shop'), description: name, def: { name: 'obj', props: {} }, display: { label: name }, references: [], updatedAt: 0,
    });
    types['shop/Price'] = record('shop/Price');
    types['shop/Product'] = record('shop/Product');
    const found = await s.types(SHOP, [QualifiedName.parse('shop/Price'), QualifiedName.parse('shop/Product'), QualifiedName.parse('shop/Gone')]);
    expect(found.types.map((t) => t.name)).toEqual(['shop/Price', 'shop/Product']);
    expect(found.missing).toEqual(['shop/Gone']);
  });
});
