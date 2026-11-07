import { IDS, SystemName, compositeKey, type GinTypeDef, type RunId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { COUNTER_FIELD, TableStateService, fieldType } from './state.ts';
import { turnScope } from './support.ts';
import { chatWorld, gin, makeRun, settle } from './testing.ts';

const text = gin({ name: 'text' });
const num = gin({ name: 'num' });
const obj = (props: Record<string, GinTypeDef>): GinTypeDef => gin({ name: 'obj', props: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])) });
const turn = IDS.turn.parse('trn_1');

/** A world with fs fns declaring state, and a run of each. */
async function world() {
  const w = await chatWorld();
  w.catalog.addFn('fs', { name: 'cd', state: obj({ cwd: text }) });
  w.catalog.addFn('fs', { name: 'bash', state: obj({ cwd: gin({ name: 'optional', generic: { T: text } }), last: num }) });
  w.catalog.addFn('fs', { name: 'odd', state: obj({ cwd: num }) });
  w.catalog.addFn('git', { name: 'status', state: obj({ cwd: text }) });
  w.catalog.checker = (_, type, value) => (type.name === 'text' && typeof value !== 'string') || (type.name === 'num' && typeof value !== 'number') ? [`expected ${type.name}`] : [];
  const run = async (id: string, fn: `${string}/${string}`, session = true): Promise<RunId> => {
    const row = makeRun({ id: IDS.run.parse(id), fn, turn, actor: w.admin.id, ...(session ? { session: w.session.id } : {}) });
    await w.store.table('runs').insert(row);
    return row.id;
  };
  return { ...w, run };
}

describe('state field types', () => {
  it('match by type, ignoring docs and optional', async () => {
    expect(await fieldType(gin({ name: 'optional', generic: { T: { name: 'text', docs: 'a folder' } } }))).toBe(await fieldType(text));
    expect(await fieldType(num)).not.toBe(await fieldType(text));
  });

  it('come from an object type, directly or through a named type', async () => {
    const w = await world();
    const state = new TableStateService(w.deps);
    w.catalog.typeRecords.set('fs/Shell', { name: 'fs/Shell', system: SystemName.parse('fs'), description: '', def: obj({ cwd: text }), display: { label: 'Shell' }, references: [], updatedAt: 0 });
    expect([...(await state.fields(SystemName.parse('fs'), gin({ name: 'fs/Shell' }))).keys()]).toEqual(['cwd']);
    expect((await state.fields(SystemName.parse('fs'), undefined)).size).toBe(0);
    await expect(state.fields(SystemName.parse('fs'), text)).rejects.toMatchObject({ code: 'invalid' });
    await expect(state.fields(SystemName.parse('fs'), gin({ name: 'fs/Missing' }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('never include the counter row\'s name', async () => {
    const w = await world();
    const fields = await new TableStateService(w.deps).fields(SystemName.parse('fs'), obj({ [COUNTER_FIELD]: num, cwd: text }));
    expect([...fields.keys()]).toEqual(['cwd']);
  });
});

describe('session state', () => {
  it('is shared by fns that declare the same name and type, and nothing else', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    const bash = await w.run('run_bash', 'fs/bash');
    const odd = await w.run('run_odd', 'fs/odd');
    const git = await w.run('run_git', 'git/status');
    expect(await w.chat.state.set({ run: cd }, { patch: { cwd: '/repo' }, clear: [] })).toEqual({ version: 1 });
    expect(await w.chat.state.get({ run: bash })).toEqual({ values: { cwd: '/repo' }, version: 1 });
    expect(await w.chat.state.get({ run: odd })).toEqual({ values: {}, version: 0 });
    expect(await w.chat.state.get({ run: git })).toEqual({ values: {}, version: 0 });
    expect(await w.chat.state.forRun(bash)).toEqual({ cwd: '/repo' });
  });

  it('refuses undeclared fields and values of the wrong type', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    await expect(w.chat.state.set({ run: cd }, { patch: { other: 1 }, clear: [] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.state.set({ run: cd }, { patch: { cwd: 3 }, clear: [] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.state.set({ run: cd }, { patch: {}, clear: ['other'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: ['cwd'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.state.get({ run: IDS.run.parse('run_none') })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a write made against an older version of the owner\'s fields', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    const bash = await w.run('run_bash', 'fs/bash');
    const read = await w.chat.state.get({ run: cd });
    await w.chat.state.set({ run: bash }, { patch: { cwd: '/b' }, clear: [] });
    expect(await w.chat.state.set({ run: cd }, { patch: { cwd: '/c' }, clear: [], version: read.version })).toEqual({ conflict: true });
    const again = await w.chat.state.get({ run: cd });
    expect(await w.chat.state.set({ run: cd }, { patch: { cwd: '/c' }, clear: [], version: again.version })).toEqual({ version: 2 });
  });

  it('does not conflict over fields the owner did not declare', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    const bash = await w.run('run_bash', 'fs/bash');
    const read = await w.chat.state.get({ run: cd });
    await w.chat.state.set({ run: bash }, { patch: { last: 0 }, clear: [] });
    expect(await w.chat.state.set({ run: cd }, { patch: { cwd: '/c' }, clear: [], version: read.version })).toEqual({ version: 2 });
  });

  it('clears fields, and versions never go back after a clear', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    await w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: [] });
    expect(await w.chat.state.set({ run: cd }, { patch: {}, clear: ['cwd'] })).toEqual({ version: 2 });
    expect(await w.chat.state.get({ run: cd })).toEqual({ values: {}, version: 2 });
    expect(await w.chat.state.set({ run: cd }, { patch: {}, clear: ['cwd'] })).toEqual({ version: 2 });
    expect(await w.chat.state.set({ run: cd }, { patch: { cwd: '/b' }, clear: [], version: 2 })).toEqual({ version: 3 });
  });

  it('records each run\'s changes with the value before, and publishes them', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    const bash = await w.run('run_bash', 'fs/bash');
    await w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: [] });
    await w.chat.state.set({ run: bash }, { patch: { cwd: '/b', last: 1 }, clear: [] });
    await w.chat.state.set({ run: bash }, { patch: {}, clear: ['last'] });
    const cwdType = await fieldType(text);
    const numType = await fieldType(num);
    expect((await w.store.table('runs').get(cd))?.stateChanges).toEqual([{ field: 'cwd', type: cwdType, after: '/a' }]);
    expect((await w.store.table('runs').get(bash))?.stateChanges).toEqual([
      { field: 'cwd', type: cwdType, before: '/a', after: '/b' }, { field: 'last', type: numType, after: 1 }, { field: 'last', type: numType, before: 1 },
    ]);
    await settle();
    expect(w.bus.of('state.changed').at(-1)).toEqual({ session: w.session.id, system: 'fs', fields: [{ name: 'last', type: numType }] });
    expect((await w.store.table('stateFields').get(compositeKey(w.session.id, 'fs', 'cwd', cwdType)))?.updatedBy).toEqual({ run: bash });
  });

  it('puts back what a run changed, unless something changed it since', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    const bash = await w.run('run_bash', 'fs/bash');
    await w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: [] });
    await w.chat.state.set({ run: bash }, { patch: { cwd: '/b', last: 1 }, clear: [] });
    await w.chat.state.revert(bash);
    expect(await w.chat.state.get({ run: bash })).toEqual({ values: { cwd: '/a' }, version: 3 });
    await w.chat.state.revert(bash);
    expect((await w.chat.state.get({ run: bash })).values).toEqual({ cwd: '/a' });
    await w.chat.state.set({ run: bash }, { patch: { cwd: '/later' }, clear: [] });
    await w.chat.state.revert(cd);
    expect((await w.chat.state.get({ run: cd })).values).toEqual({ cwd: '/later' });
    expect(w.logs.some((l) => l.msg === 'chat.state.revert.skipped')).toBe(true);
  });

  it('puts back a cleared field', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    const bash = await w.run('run_bash', 'fs/bash');
    await w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: [] });
    await w.chat.state.set({ run: bash }, { patch: {}, clear: ['cwd'] });
    await w.chat.state.revert(bash);
    expect((await w.chat.state.get({ run: cd })).values).toEqual({ cwd: '/a' });
    await w.chat.state.revert(await w.run('run_none', 'fs/cd'));
  });

  it('scopes a sessionless run\'s state to its turn', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd', false);
    await w.chat.state.set({ run: cd }, { patch: { cwd: '/tmp' }, clear: [] });
    expect((await w.store.table('stateFields').find({ where: { session: turnScope(turn) }, limit: 10 })).items.map((r) => r.name).sort()).toEqual([COUNTER_FIELD, 'cwd']);
    expect((await w.chat.state.get({ run: await w.run('run_bash', 'fs/bash') })).values).toEqual({});
  });

  it('serves actions the fields they declared', async () => {
    const w = await world();
    w.catalog.addEntry('actions', 'fs/open', { name: 'open', description: 'Open.', input: gin({ name: 'any' }), returns: gin({ name: 'any' }), state: obj({ cwd: text }) });
    await w.chat.state.set({ run: await w.run('run_cd', 'fs/cd') }, { patch: { cwd: '/x' }, clear: [] });
    const delivery = IDS.delivery.parse('dlv_1');
    await w.store.table('deliveries').insert({ id: delivery, system: SystemName.parse('fs'), kind: { action: 'open', input: {} }, session: w.session.id, actor: w.admin.id, status: 'delivered', attempts: 1, createdAt: 0 });
    expect(await w.chat.state.get({ delivery })).toEqual({ values: { cwd: '/x' }, version: 1 });
    expect(await w.chat.state.set({ delivery }, { patch: { cwd: '/y' }, clear: [] })).toEqual({ version: 2 });
    const form = IDS.delivery.parse('dlv_2');
    await w.store.table('deliveries').insert({ id: form, system: SystemName.parse('fs'), kind: { form: IDS.run.parse('run_cd'), value: {} }, session: w.session.id, actor: w.admin.id, status: 'queued', attempts: 0, createdAt: 0 });
    await expect(w.chat.state.get({ delivery: form })).rejects.toMatchObject({ code: 'invalid' });
    await expect(w.chat.state.get({ delivery: IDS.delivery.parse('dlv_none') })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rolls back a write that fails part way', async () => {
    const w = await world();
    const cd = await w.run('run_cd', 'fs/cd');
    w.store.failNextUpdate('runs');
    await expect(w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: [] })).rejects.toThrow('on purpose');
    expect(await w.store.table('stateFields').count()).toBe(0);
    expect(await w.chat.state.set({ run: cd }, { patch: { cwd: '/a' }, clear: [] })).toEqual({ version: 1 });
  });
});
