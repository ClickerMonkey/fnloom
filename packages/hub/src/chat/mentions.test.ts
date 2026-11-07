import { IDS, SystemName, type ContextRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { chatWorld, gin } from './testing.ts';

const any = gin({ name: 'any' });

async function world(systems: SystemName[] | 'all' = 'all') {
  const w = await chatWorld({ systems });
  for (const name of ['fns', 'context', 'resources'] as const) { w.catalog.addEntry('mentions', `hub/${name}`, { name, title: name, description: name, target: any }); }
  w.catalog.addEntry('mentions', 'crm/rows', { name: 'rows', title: 'Rows', description: 'Rows.', target: any });
  const ask = (provider: `${string}/${string}`) => ({ session: w.session.id, actor: w.admin.id, provider });
  return { ...w, ask };
}

describe('mentions from systems', () => {
  it('search and hover over the link as the person, with the provider\'s local name', async () => {
    const w = await world();
    const crm = w.link.connect('crm', {
      mentions: async ({ query, user }) => Promise.resolve([{ label: `${query} for ${user.name}`, target: { id: 1 } }]),
      mentionHover: async ({ target }) => Promise.resolve({ hover: { title: `Row ${JSON.stringify(target)}` } }),
    });
    expect(await w.chat.mentions.search(w.ask('crm/rows'), 'acme')).toEqual([{ label: 'acme for Ada', target: { id: 1 } }]);
    expect(await w.chat.mentions.hover(w.ask('crm/rows'), { id: 1 })).toEqual({ title: 'Row {"id":1}' });
    expect(crm.calls[0]?.data).toMatchObject({ provider: 'rows', query: 'acme', session: w.session.id, actor: w.admin.id, time: { timeZone: 'UTC' } });
    expect(crm.calls[1]?.data).toMatchObject({ provider: 'rows', target: { id: 1 } });
  });

  it('are refused outside the session, for systems it excludes, and for bad targets', async () => {
    const w = await world([SystemName.parse('crm')]);
    const bo = await w.user('Bo');
    await expect(w.chat.mentions.search({ ...w.ask('crm/rows'), actor: bo.id }, 'x')).rejects.toMatchObject({ code: 'not-found' });
    await expect(w.chat.mentions.search(w.ask('fs/files'), 'x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(w.chat.mentions.search(w.ask('crm/rows'), 'x')).rejects.toMatchObject({ code: 'unavailable' });
    w.catalog.checker = () => ['expected { id }'];
    await expect(w.chat.mentions.hover(w.ask('crm/rows'), 'x')).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.mentions.hover(w.ask('crm/other'), 'x')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('the hub\'s own mentions', () => {
  it('list available fns of the session\'s systems for an empty query, and search the index otherwise', async () => {
    const w = await world([SystemName.parse('fs')]);
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.' });
    w.catalog.addFn('crm', { name: 'find' });
    const off = w.catalog.addFn('fs', { name: 'off' });
    w.catalog.fnRecords.set(off.name, { ...off, available: { unavailable: 'disabled', detail: 'off' } });
    expect((await w.chat.mentions.search(w.ask('hub/fns'), ' ')).map((o) => o.label)).toEqual(['hub/chat', 'fs/read']);
    w.index.hits = [{ kind: 'fn', key: 'fs/read', score: 1, text: 'Read a file.' }, { kind: 'context', key: 'fs/guide', score: 1, text: 'Guide.' }];
    expect(await w.chat.mentions.search(w.ask('hub/fns'), 'read')).toEqual([{ label: 'fs/read', hint: 'Read a file.', target: { fn: 'fs/read' } }]);
    expect(w.index.searched.at(-1)).toEqual({ text: 'read', kinds: ['fn'], limit: 10, systems: ['hub', 'fs'] });
    expect(await w.chat.mentions.search(w.ask('hub/context'), 'guide')).toEqual([{ label: 'fs/guide', hint: 'Guide.', target: { context: 'fs/guide' } }]);
  });

  it('find resources and their sections', async () => {
    const w = await world();
    w.index.hits = [{ kind: 'section', key: 'fs://repo/docs/a%20b.md#Intro', score: 1, text: 'Intro text' }, { kind: 'section', key: 'fs://repo/', score: 1, text: 'Root' }, { kind: 'section', key: 'fs://repo/100%.md', score: 1, text: 'Odd' }];
    expect(await w.chat.mentions.search(w.ask('hub/resources'), 'intro')).toEqual([
      { label: 'a b.md', hint: 'Intro text', target: { uri: 'fs://repo/docs/a%20b.md', section: 'Intro' } },
      { label: 'repo', hint: 'Root', target: { uri: 'fs://repo/' } },
      { label: '100%.md', hint: 'Odd', target: { uri: 'fs://repo/100%.md' } },
    ]);
  });

  it('describe fns, context and resources on hover', async () => {
    const w = await world();
    w.catalog.addFn('fs', { name: 'read', description: 'Read a file.', tags: ['read'] });
    const guide: ContextRecord = {
      name: 'fs/guide', system: SystemName.parse('fs'), stale: false, updatedAt: 0, mentions: { context: [], fns: [] },
      decl: { name: 'guide', description: 'How files work.', imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [] },
    };
    w.catalog.contexts.set(guide.name, guide);
    expect(await w.chat.mentions.hover(w.ask('hub/fns'), { fn: 'fs/read' })).toEqual({
      title: 'fs/read', subtitle: 'fs · native', body: 'Read a file.', fields: [{ label: 'Available', value: 'yes' }, { label: 'Tags', value: 'read' }],
    });
    expect(await w.chat.mentions.hover(w.ask('hub/fns'), { fn: 'fs/none' })).toBeUndefined();
    expect(await w.chat.mentions.hover(w.ask('hub/context'), { context: 'fs/guide' })).toEqual({ title: 'fs/guide', subtitle: 'fs', body: 'How files work.' });
    expect(await w.chat.mentions.hover(w.ask('hub/resources'), { uri: 'fs://repo/a.md', section: 'Intro' })).toEqual({
      title: 'a.md', subtitle: 'fs://repo/a.md § Intro', open: { resource: 'fs://repo/a.md', title: 'a.md' },
    });
    expect(await w.chat.mentions.hover(w.ask('hub/resources'), { uri: 'not a uri' })).toEqual({ title: 'not a uri', subtitle: 'not a uri' });
    await expect(w.chat.mentions.hover(w.ask('hub/fns'), { fn: 'unqualified' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('write LLM text for context, resources, and fns that can\'t be used or don\'t exist', async () => {
    const w = await world();
    const record = w.catalog.addFn('fs', { name: 'write', description: 'Write a file.' });
    w.catalog.fnRecords.set(record.name, { ...record, available: { unavailable: 'system-disconnected', detail: 'fs is offline' } });
    const send = async (provider: `${string}/${string}`, target: Record<string, string>) => {
      const sent = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: { timeZone: 'UTC', locale: 'en', now: 0 }, parts: [{ type: 'mention', provider, label: 'x', target }] });
      const part = sent.message.parts[0];
      return part?.type === 'mention' ? part.text : undefined;
    };
    expect(await send('hub/fns', { fn: 'fs/write' })).toBe('The fn fs/write of the fs system: Write a file. It can\'t be used now: fs is offline.');
    expect(await send('hub/fns', { fn: 'fs/none' })).toBe('The fn fs/none, which the hub does not know.');
    expect(await send('hub/context', { context: 'fs/none' })).toBe('The context fs/none, which the hub does not know.');
    expect(await send('hub/resources', { uri: 'fs://repo/a.md' })).toBe('The resource fs://repo/a.md.');
    expect(await send('hub/resources', { uri: 'fs://repo/a.md', section: 'Intro' })).toBe('The section "Intro" of the resource fs://repo/a.md.');
    expect(IDS.session.parse(w.session.id)).toBe(w.session.id);
  });
});
