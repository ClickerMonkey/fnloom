import { openScope, type AccessScope } from '../access/index.ts';
import { fn, hub, type AnyFnRef } from '@harness/sdk';
import { QualifiedName, ResourceUri, type ActorId, type Json, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunInput } from '../execution/index.ts';
import { ALICE, executionRig, SESSION, type ExecutionRig } from '../execution/testing.ts';
import { registerResourceFns, type ReachScope } from './fns.ts';
import type { ResourceServices } from './index.ts';
import { bytes, resourcesRig, statOf } from './testing.ts';

/** The resource fns this module implements. */
const NAMES = [
  'resource_list', 'resource_read', 'ctx_get', 'resource_outline', 'resource_send', 'resource_convert', 'resource_import', 'resource_rename',
  'resource_delete', 'ctx_from_resource', 'remember', 'forget',
] as const satisfies ReadonlyArray<keyof typeof hub.fns>;

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** Put a hub fn in the rig's catalog with the contract's args and result. */
function addHubFn(r: ExecutionRig, ref: AnyFnRef): void {
  r.catalog.add('hub', ref.name.slice('hub/'.length), fn({ description: ref.name, args: ref.args, returns: ref.returns, tags: ['read'] }));
}

/** The rig, its fns registered; while `scope` gives one, every run's caller acts as a hub MCP with that scope. */
async function started(scope: () => ReachScope | undefined = () => undefined, access: (actor: ActorId) => AccessScope = openScope) {
  const r = await executionRig();
  rig = r;
  const resources = await resourcesRig();
  const services: ResourceServices = {
    library: resources.library, forms: resources.forms, reader: resources.reader, context: resources.context,
    content: { parts: () => Promise.resolve([{ type: 'text', content: 'the text', name: 'a.md' }]) },
  };
  for (const name of NAMES) { addHubFn(r, hub.fns[name]); }
  registerResourceFns(r.module.hubFns, { resources: () => services, store: () => r.store, llm: () => ({ models: () => Promise.resolve([]) }), mcpScope: () => Promise.resolve(scope()), access: (actor) => Promise.resolve(access(actor)) });
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
    expect(await call(r, turn, 'ctx_get', { name })).toMatchObject({ status: 'done', result: { text: 'Use tabs here.' } });
    expect(await call(r, turn, 'forget', { name })).toEqual({ status: 'done', result: { ok: true } });
    expect(await call(r, turn, 'ctx_from_resource', { uri })).toMatchObject({ status: 'done', result: { links: 2 } });
  });

  it('refuses bad args before running the operation', async () => {
    const { r, turn } = await started();
    const settled = await call(r, turn, 'resource_read', { uri: 'not a uri' });
    expect(settled.status).not.toBe('done');
  });
});

describe('context made from a resource', () => {
  it('reads as missing once its resource is under a root the person may not see', async () => {
    const uri = ResourceUri.parse('file://main/private/plan.md');
    const hide = { private: false };
    const sees = (at: string): boolean => !(hide.private && at.startsWith('file://main/private'));
    const { r, resources, turn } = await started(undefined, (actor) => ({
      ...openScope(actor), seesUri: sees, seesContext: (record) => record.origin?.type !== 'resource' || sees(record.origin.uri),
    }));
    resources.raw.serve({ stat: statOf(uri, { format: 'markdown' }), bytes: bytes('# Plan\nsecret plan\n') });
    const made = await call(r, turn, 'ctx_from_resource', { uri });
    const { created } = z.object({ created: z.array(QualifiedName) }).parse(made.status === 'done' ? made.result : {});
    const name = created[0];
    if (name === undefined) throw new Error('no context made');
    // the run reads records from the hub store; this rig keeps the resource module's apart
    for (const made of created) { const record = await resources.store.table('context').get(made); if (record !== undefined) await r.store.table('context').insert(record); }
    expect(await call(r, turn, 'ctx_get', { name })).toMatchObject({ status: 'done' });
    hide.private = true;
    const hidden = await call(r, turn, 'ctx_get', { name });
    expect(hidden.status).not.toBe('done');
    expect(JSON.stringify(hidden)).not.toContain('secret plan');
  });
});

describe('through a hub MCP', () => {
  it('keeps to its rules: a resource outside them or context it does not expose reads as missing, and listings leave them out', async () => {
    const open = ResourceUri.parse('file://main/guide.md');
    const hidden = ResourceUri.parse('file://main/private/keys.md');
    const mcp: { scope?: ReachScope } = {};
    const { r, resources, turn } = await started(() => mcp.scope);
    resources.raw.serve({ stat: statOf(open, { format: 'markdown' }), bytes: bytes('# Open\n') });
    resources.raw.serve({ stat: statOf(hidden, { format: 'markdown' }), bytes: bytes('# Secret\n') });
    // the person reads both outside the MCP, so the library knows them
    expect(await call(r, turn, 'resource_read', { uri: open })).toMatchObject({ status: 'done' });
    expect(await call(r, turn, 'resource_read', { uri: hidden })).toMatchObject({ status: 'done' });
    mcp.scope = { context: new Set(), allowsResource: (uri) => !uri.startsWith('file://main/private') };
    for (const name of ['resource_read', 'resource_outline', 'resource_send', 'ctx_from_resource'] as const) {
      const settled = await call(r, turn, name, { uri: hidden });
      expect(settled.status, name).not.toBe('done');
      expect(JSON.stringify(settled), name).not.toContain('Secret');
    }
    const listed = await call(r, turn, 'resource_list', {});
    // the counts are over what it can reach: one document, never the hidden one
    expect(listed).toMatchObject({ status: 'done', result: { items: [{ uri: open }], facets: [{ value: 'document', count: 1 }] } });
    expect(JSON.stringify(listed)).not.toContain(hidden);
    const remembered = await call(r, turn, 'remember', { text: 'Use tabs here.' });
    const { name } = z.object({ name: QualifiedName }).parse(remembered.status === 'done' ? remembered.result : {});
    expect((await call(r, turn, 'ctx_get', { name })).status).not.toBe('done');
  });
});

describe('importing through a fn', () => {
  it('takes the import union as its `input` field, as the contract makes it', async () => {
    const { r, resources, turn } = await started();
    const content = await resources.content.put(bytes('# Note\n'), 'text/markdown');
    const settled = await call(r, turn, 'resource_import', { content, name: 'note.md' });
    expect(settled).toMatchObject({ status: 'done', result: { uri: 'hub://resources/uploads/2026-11-07/note.md', source: { from: 'upload' } } });
  });
});
