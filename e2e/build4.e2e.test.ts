/**
 * Build 4 on the real stack, API-level: the web system's `crawl` keeps each page as a resource under one root per
 * crawl (only with `TAVILY_API_KEY`, which the stack needs to run the web system); visibility is set and read back on a
 * fn and a crawl root, and put back. (A fn's output hook on its stored record is unit-tested in the SDK: no system on
 * the stack declares one since get_query moved onto the authoring agent.)
 */
import { QualifiedName, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SignedIn } from '../scripts/hub-client.ts';
import { admin, invoke, settings, settle } from './kit.ts';

let me: SignedIn;
let session: SessionId;

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e build 4' })).id;
});

afterAll(() => { me.close(); });

describe.skipIf(settings.TAVILY_API_KEY === undefined)('web crawl', () => {
  it('keeps the start page as a resource under the crawl\'s own root, which has a visibility', async () => {
    const run = await invoke(me, session, QualifiedName.parse('web/crawl'), { url: 'https://example.com/', depth: 0, maxPages: 1 });
    expect(run.status, JSON.stringify(run.outcome)).toBe('done');
    const result = run.outcome?.status === 'done' ? run.outcome.result : undefined;
    expect(result).toMatchObject({ count: 1 });
    const { root } = z.object({ root: z.string().min(1) }).parse(result);
    const set = await me.hub.call('setAccess', { target: { kind: 'root', uri: root }, sharing: { visibility: 'private', with: [] } });
    expect(set.sharing.visibility).toBe('private');
    await me.hub.call('setAccess', { target: { kind: 'root', uri: root }, sharing: { visibility: 'public', with: [] } });
  });
});

describe('visibility', () => {
  it('sets a fn private and public again, and the hub says so', async () => {
    const target = { kind: 'fn' as const, fn: QualifiedName.parse('fs/glob') };
    expect((await me.hub.call('setAccess', { target, sharing: { visibility: 'private', with: [] } })).sharing.visibility).toBe('private');
    expect((await me.hub.call('setAccess', { target, sharing: { visibility: 'public', with: [] } })).sharing.visibility).toBe('public');
  });
});

