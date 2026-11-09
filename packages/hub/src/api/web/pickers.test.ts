import { ActorId, KindRecord, QualifiedName, ResourceUri, SystemName, TypeRecord, type Actor } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope, type AccessScope } from '../../access/index.ts';
import { FixtureCatalog } from '../../chat/testing.ts';
import { queryEnv } from '../../query/env.ts';
import { testStore } from '../../testing.ts';
import { matchScore, pick, type PickerDeps } from './pickers.ts';

const ADA = ActorId.parse('act_ada');
const person = (id: string, name: string): Actor => ({ id: ActorId.parse(id), kind: 'user', name, email: `${name}@x`, role: 'member', about: '', createdAt: 0, disabled: false });

async function world(scope: Partial<AccessScope> = {}): Promise<PickerDeps> {
  const store = await testStore();
  for (const actor of [person('act_ada', 'Ada'), person('act_ben', 'Ben')]) await store.table('actors').insert(actor);
  const catalog = new FixtureCatalog();
  catalog.addFn('fs', { name: 'read', description: 'Read a file.' });
  catalog.addFn('fs', { name: 'grep', description: 'Search files for text.' });
  catalog.addFn('notes', { name: 'secret', description: 'Private notes.' });
  return {
    access: { scope: (actor) => Promise.resolve({ ...openScope(actor), ...scope }) },
    catalog,
    store,
    llm: { models: () => Promise.resolve([{ id: 'qwen2.5:3b', provider: 'ollama', name: 'Qwen 2.5 3B', capabilities: ['chat'] }]) },
    settings: queryEnv.parse(),
  };
}

describe('pick', () => {
  it('ranks exact and prefix matches first, and searches hints last', () => {
    const option = { value: 'fs/read', label: 'fs/read', hint: 'Read a file.' };
    expect(matchScore(option, 'fs/read')).toBeGreaterThan(matchScore(option, 'fs'));
    expect(matchScore(option, 'read')).toBeGreaterThan(matchScore(option, 'ea'));
    expect(matchScore(option, 'file')).toBe(1);
    expect(matchScore(option, 'nope')).toBe(0);
  });

  it('answers only what the asker may see, best match first', async () => {
    const deps = await world({ seesFn: (fn) => fn.system !== 'notes' });
    expect((await pick(deps, ADA, { source: 'fn', text: '' })).map((o) => o.value)).toEqual(['fs/read', 'fs/grep']);
    expect((await pick(deps, ADA, { source: 'fn', text: 'grep' })).map((o) => o.value)).toEqual(['fs/grep']);
    expect((await pick(deps, ADA, { source: 'fn', text: 'search' })).map((o) => o.value)).toEqual(['fs/grep']);
    expect(await pick(deps, ADA, { source: 'person', text: 'be' })).toEqual([{ value: 'act_ben', label: 'Ben', hint: 'Ben@x', icon: 'person' }]);
    expect(await pick(deps, ADA, { source: 'model', text: 'qwen' })).toEqual([{ value: 'qwen2.5:3b', label: 'Qwen 2.5 3B', hint: 'ollama' }]);
  });

  it('labels chips by value, marking values that are gone or hidden as missing', async () => {
    const deps = await world({ seesFn: (fn) => fn.system !== 'notes' });
    expect(await pick(deps, ADA, { source: 'fn', values: ['fs/read', 'notes/secret', 'fs/gone'] })).toEqual([
      { value: 'fs/read', label: 'fs/read', hint: 'Read a file.', icon: 'fn' },
      { value: 'notes/secret', label: 'notes/secret', missing: true },
      { value: 'fs/gone', label: 'fs/gone', missing: true },
    ]);
    expect((await pick(deps, ADA, { source: 'kind', text: 'nat' }))[0]?.value).toBe('native');
  });

  it('reads systems, context, people, groups, resources, types and kinds from the store', async () => {
    const deps = await world({ seesUri: (uri) => !uri.includes('secret') });
    const fs = SystemName.parse('fs');
    await deps.store.table('systems').insert({ name: fs, description: 'Files.', status: 'connected', enabled: { functions: true, renderers: true }, version: '1', manifestHash: 'h', actor: ADA });
    await deps.store.table('context').insert(new FixtureCatalog().addContext('fs', { name: 'guide', description: 'How to use fs.' }));
    await deps.store.table('actors').insert({ id: ActorId.parse('act_team'), kind: 'group', name: 'Team', about: '', createdAt: 0, disabled: false });
    for (const name of ['notes.md', 'secret.md']) {
      const uri = ResourceUri.parse(`fs://work/${name}`);
      await deps.store.table('resources').insert({ uri, system: fs, stat: { uri, name, type: 'file', version: 'v1' }, links: [], seenAt: 1 });
    }
    await deps.store.table('types').insert(TypeRecord.parse({ name: QualifiedName.parse('fs/Entry'), system: fs, description: 'A file.', def: { name: 'text' }, display: { label: 'Entry' }, references: [], updatedAt: 1 }));
    await deps.store.table('kinds').insert(KindRecord.parse({ name: QualifiedName.parse('input/form'), system: SystemName.parse('input'), decl: { name: 'form', description: 'A form.', applicability: 'Asking.', payload: { name: 'text' }, approveChanges: false } }));
    const values = async (source: Parameters<typeof pick>[2]['source']) => (await pick(deps, ADA, { source, text: '' })).map((o) => o.value);
    expect(await values('system')).toEqual(['fs']);
    expect(await values('context')).toEqual(['fs/guide']);
    expect(await values('group')).toEqual(['act_team']);
    expect(await values('resource')).toEqual(['fs://work/notes.md']);
    expect(await values('type')).toEqual(['fs/Entry']);
    expect(await values('kind')).toEqual(['native', 'input/form']);
  });
});
