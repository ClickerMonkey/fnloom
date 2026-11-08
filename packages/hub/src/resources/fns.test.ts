import { fn, hub, type AnyFnRef } from '@harness/sdk';
import { QualifiedName, ResourceUri, type Json, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunInput } from '../execution/index.ts';
import { ALICE, executionRig, SESSION, type ExecutionRig } from '../execution/testing.ts';
import { registerResourceFns } from './fns.ts';
import type { ResourceServices } from './index.ts';
import { bytes, resourcesRig, statOf } from './testing.ts';

/** The resource fns this module implements. */
const NAMES = [
  'resource_list', 'resource_read', 'context_get', 'resource_outline', 'resource_send', 'resource_convert', 'resource_import', 'resource_rename',
  'resource_delete', 'context_from_resource', 'remember', 'forget',
] as const satisfies ReadonlyArray<keyof typeof hub.fns>;

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** Put a hub fn in the rig's catalog with the contract's args and result. */
function addHubFn(r: ExecutionRig, ref: AnyFnRef): void {
  r.catalog.add('hub', ref.name.slice('hub/'.length), fn({ description: ref.name, args: ref.args, returns: ref.returns, tags: ['read'] }));
}

async function started() {
  const r = await executionRig();
  rig = r;
  const resources = await resourcesRig();
  const services: ResourceServices = {
    library: resources.library, forms: resources.forms, reader: resources.reader, context: resources.context,
    content: { parts: () => Promise.resolve([{ type: 'text', content: 'the text', name: 'a.md' }]) },
  };
  for (const name of NAMES) { addHubFn(r, hub.fns[name]); }
  registerResourceFns(r.module.hubFns, { resources: () => services, store: () => r.store, llm: () => ({ models: () => Promise.resolve([]) }) });
  await r.session({});
  await r.module.start();
  return { r, resources, turn: await r.turn({ session: SESSION, text: 'hello' }) };
}

async function call(r: ExecutionRig, turn: Turn, name: (typeof NAMES)[number], args: Json) {
  const input: RunInput = { fn: QualifiedName.parse(`hub/${name}`), args, turn: turn.id, session: SESSION, key: `${name}:${JSON.stringify(args)}`, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
  return (await r.module.runs.start(input)).settled;
}

describe('the resource hub fns', () => {
  it('registers every resource and context fn of the hub contract', async () => {
    const { r } = await started();
    for (const name of NAMES) { expect(r.module.hubFns.has(QualifiedName.parse(`hub/${name}`)), name).toBe(true); }
  });

  it('reads, outlines and sends a resource as the run\'s person, with results that fit the contract', async () => {
    const { r, resources, turn } = await started();
    const uri = ResourceUri.parse('file://main/guide.md');
    resources.raw.serve({ stat: statOf(uri, { format: 'markdown' }), bytes: bytes('# One\nfirst\n# Two\nsecond\n') });
    const read = await call(r, turn, 'resource_read', { uri, maxChars: 8 });
    expect(read).toMatchObject({ status: 'done', result: { uri, form: 'raw', text: '# One\nfi', truncated: true } });
    const outline = await call(r, turn, 'resource_outline', { uri });
    expect(outline.status === 'done' ? outline.result : outline).toMatchObject([{ key: 'One' }, { key: 'Two' }]);
    expect(await call(r, turn, 'resource_send', { uri })).toEqual({ status: 'done', result: { parts: [{ type: 'text', name: 'a.md', chars: 8 }] } });
    const listed = await call(r, turn, 'resource_list', { group: 'type' });
    expect(listed).toMatchObject({ status: 'done', result: { items: [{ uri }], facets: [{ value: 'document', count: 1 }] } });
  });

  it('remembers in the run\'s session, makes context from a resource, and forgets', async () => {
    const { r, resources, turn } = await started();
    const uri = ResourceUri.parse('file://main/guide.md');
    resources.raw.serve({ stat: statOf(uri, { format: 'markdown' }), bytes: bytes('# One\nfirst\n') });
    const remembered = await call(r, turn, 'remember', { text: 'Use tabs here.' });
    expect(remembered.status).toBe('done');
    const { name } = z.object({ name: QualifiedName }).parse(remembered.status === 'done' ? remembered.result : {});
    expect((await resources.store.table('context').get(name))?.origin).toMatchObject({ scope: { to: 'session', session: SESSION } });
    expect(await call(r, turn, 'context_get', { name })).toMatchObject({ status: 'done', result: { text: 'Use tabs here.' } });
    expect(await call(r, turn, 'forget', { name })).toEqual({ status: 'done', result: { ok: true } });
    expect(await call(r, turn, 'context_from_resource', { uri })).toMatchObject({ status: 'done', result: { links: 2 } });
  });

  it('refuses bad args before running the operation', async () => {
    const { r, turn } = await started();
    const settled = await call(r, turn, 'resource_read', { uri: 'not a uri' });
    expect(settled.status).not.toBe('done');
  });
});

describe('importing through a fn', () => {
  it('takes the import union as its `input` field, as the contract makes it', async () => {
    const { r, resources, turn } = await started();
    const content = await resources.content.put(bytes('# Note\n'), 'text/markdown');
    const settled = await call(r, turn, 'resource_import', { input: { content, name: 'note.md' } });
    expect(settled).toMatchObject({ status: 'done', result: { uri: 'hub://resources/uploads/2026-11-07/note.md', source: { from: 'upload' } } });
  });
});
