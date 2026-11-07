import { Manifest } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { context, hook, mention, type } from './declare.ts';
import { fn, handler, linear } from './fn.ts';
import { g } from './gin.ts';
import { hub } from './hub.ts';
import { agent } from './agent.ts';
import { canonicalJson, manifestBody, manifestOf, sha256 } from './manifest.ts';
import { system } from './system.ts';

const notes = system('notes', { description: 'Notes.' })
  .with({
    config: g.obj({ folder: g.text() }),
    types: {
      Note: type({
        description: 'A note.',
        shape: g.obj({ id: g.text(), title: g.text() }),
        display: { label: 'Note', title: 'title' },
        methods: { pin: fn({ description: 'Pin it.', args: g.obj({}), returns: g.bool(), visibility: 'user' }) },
      }),
    },
    fns: {
      find: fn({ description: 'Find notes.', args: g.obj({ q: g.text() }), returns: g.list(g.text()), progress: linear, tags: ['read'], deps: { search: hub.fns.search_resources },
        handlers: { pick: handler({ description: 'Pick one.', args: g.obj({ options: g.list(g.text()) }), returns: g.text(), required: false }) } }),
    },
    hooks: { recent: hook({ description: 'Recent notes.' }) },
  })
  .with(({ fns, types }) => ({
    context: { how: context({ description: 'How.', content: 'Find first.', fns: [fns.find] }) },
    mentions: { notes: mention({ title: 'Notes', description: 'Any note.', target: g.obj({ id: g.text() }), of: types.Note }) },
    fns: { ask: agent({ description: 'Ask.', args: g.obj({ q: g.text() }), returns: g.text(), instructions: 'Answer.', tools: [fns.find] }) },
  }));

describe('manifestOf', () => {
  it('builds a manifest core accepts, with every section', async () => {
    const manifest = await manifestOf(notes, { version: '1.0.0', events: ['message'], resources: true });
    expect(Manifest.safeParse(manifest).success).toBe(true);
    expect(manifest.name).toBe('notes');
    expect(manifest.types.map((t) => t.name)).toEqual(['Note']);
    expect(manifest.hooks).toEqual([{ name: 'recent', description: 'Recent notes.', order: 100, timeout: 1000 }]);
    expect(manifest.context[0]?.fns).toEqual(['notes/find']);
    expect(manifest.mentions[0]?.of).toBe('notes/Note');
    expect(manifest.events).toEqual(['message']);
    expect(manifest.resources).toBe(true);
  });

  it('sends a type\'s methods as fns named Type.method whose args hold self', async () => {
    const manifest = await manifestOf(notes, { version: '1' });
    const pin = manifest.fns.find((f) => f.name === 'Note.pin');
    expect(pin?.visibility).toBe('user');
    expect(JSON.stringify(pin?.args)).toContain('self');
  });

  it('declares native fns with deps, handlers and progress, and agents as hub/llm with a payload', async () => {
    const manifest = await manifestOf(notes, { version: '1' });
    const find = manifest.fns.find((f) => f.name === 'find');
    expect(find).toMatchObject({ kind: 'native', deps: ['hub/search_resources'], progress: { type: 'linear' }, tags: ['read'] });
    expect(find?.handlers['pick']?.required).toBe(false);
    const ask = manifest.fns.find((f) => f.name === 'ask');
    expect(ask?.kind).toBe('hub/llm');
    expect(ask?.payload).toMatchObject({ tools: ['notes/find'], instructions: 'Answer.' });
  });

  it('lists the other systems it refers to', async () => {
    expect((await manifestOf(notes, { version: '1' })).requires).toEqual(['hub']);
  });

  it('hashes the body so equal contracts hash the same and a change changes the hash', async () => {
    const a = await manifestOf(notes, { version: '1' });
    const b = await manifestOf(notes, { version: '1' });
    const c = await manifestOf(notes, { version: '2' });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds the hub\'s own manifest', async () => {
    const body = manifestBody(hub, { version: '0' });
    expect(body.kinds.map((k) => k.name)).toEqual(['llm']);
    expect(body.fns.map((f) => f.name)).toContain('chat');
    expect(Manifest.safeParse(await manifestOf(hub, { version: '0' })).success).toBe(true);
  });
});

describe('canonicalJson and sha256', () => {
  it('sorts object keys so key order never changes a hash', async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
