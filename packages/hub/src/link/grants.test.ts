import { ApiError } from '@ayepi/core';
import { ActorId, MAIN_INSTANCE, mintId, QualifiedName, SystemName, TurnId, type LinkSession, type Manifest, type Run, type SystemGrants } from '@harness/core';
import { fn, g, system } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestFor } from '../catalog/fixtures.ts';
import { capabilityOf } from './grants.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from './rig.ts';

const NOTES = SystemName.parse('notes');
const LINK: LinkSession = { system: NOTES, instance: MAIN_INSTANCE, boot: 'b1' };

const notes = system('notes', { description: 'Notes.' }).with({
  fns: {
    read: fn({ description: 'Read a note.', args: g.obj({ id: g.text() }), returns: g.text(), effects: { mode: 'read' } }),
    write: fn({ description: 'Write a note.', args: g.obj({ id: g.text() }), returns: g.bool(), effects: { mode: 'write' } }),
    wipe: fn({ description: 'Delete every note.', args: g.obj({}), returns: g.bool(), effects: { mode: 'delete' } }),
    peek: fn({ description: 'Read the projects table.', args: g.obj({}), returns: g.text(), effects: { mode: 'read', reads: [QualifiedName.parse('database/projects')] } }),
  },
});

let rig: LinkRig;
const started: LinkRig[] = [];
afterEach(async () => { for (const one of started.splice(0)) { await one.stop(); } });

/** A rig, stopped after the test. */
async function newRig(options: Parameters<typeof linkRig>[0] = {}): Promise<LinkRig> {
  rig = await linkRig(options);
  started.push(rig);
  return rig;
}

/** A rig enforcing grants, with notes connected and live, declaring `grants`. */
async function withGrants(grants: SystemGrants | undefined, pause = 50): Promise<Manifest> {
  await newRig({ review: { HARNESS_GRANTS: 'enforce', HARNESS_REFUSALS_PAUSE: pause } });
  const manifest = { ...await manifestFor(notes), ...(grants === undefined ? {} : { grants }) };
  const fake = new FakeSystem(rig.app, 'notes', manifest);
  await pairDirectly(rig, fake);
  await fake.start();
  return manifest;
}

/** A running run of a notes fn, as the hub keeps it. */
async function runOf(name: string): Promise<Run> {
  const id = mintId('run');
  const actor = ActorId.parse('act_admin');
  return rig.store.table('runs').insert({
    id, fn: QualifiedName.parse(`notes/${name}`), fnVersion: '1', kind: 'native', system: NOTES, root: id, turn: TurnId.parse('trn_1'), key: 'k', actor, caller: actor,
    args: {}, status: 'running', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: 'interactive', background: false,
    attempt: 1, errors: [], stateChanges: [], createdAt: rig.time.now,
  });
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof ApiError && error.status === 403) { return error.message; }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('capabilities', () => {
  it('maps endpoints to their capability, with the base needing none', () => {
    expect(capabilityOf('llm')).toBe('ai');
    expect(capabilityOf('stateSet')).toBe('state');
    expect(capabilityOf('progress')).toBeUndefined();
    expect(capabilityOf('manifest')).toBeUndefined();
  });

  it('gives a system that declares nothing the base only, and logs each refusal', async () => {
    await withGrants(undefined);
    await rig.grants.check(LINK, 'progress', {});
    expect(await refused(rig.grants.check(LINK, 'llm', {}))).toContain('ai capability');
    expect(await refused(rig.grants.check(LINK, 'stateGet', {}))).toContain('state capability');
    const page = await rig.store.table('refusals').find({ where: { system: NOTES }, order: [['at', 'desc']], limit: 10 });
    expect(page.items.map((r) => [r.rule, r.attempt])).toEqual(expect.arrayContaining([['capability', 'llm'], ['capability', 'stateGet']]));
  });

  it('only logs in log mode', async () => {
    await newRig({ review: { HARNESS_GRANTS: 'log' } });
    await rig.grants.check(LINK, 'llm', {});
    expect(await rig.store.table('refusals').count({ system: NOTES })).toBe(1);
  });
});

describe('calls and modes', () => {
  it('lets a system call its own fns, and others only as declared', async () => {
    await withGrants({ hub: ['fns'], calls: [SystemName.parse('database')] });
    const parent = await runOf('write');
    await rig.grants.check(LINK, 'call', { parent: parent.id, fn: 'notes/read' });
    await rig.grants.check(LINK, 'call', { parent: parent.id, fn: 'database/query_run' });
    expect(await refused(rig.grants.check(LINK, 'call', { parent: parent.id, fn: 'fs/write' }))).toBe('it didn\'t declare that it calls fs/write');
  });

  it('keeps a read fn from writing, and a write fn from deleting', async () => {
    await withGrants({ hub: ['approvals'] });
    const reader = await runOf('read');
    expect(await refused(rig.grants.check(LINK, 'call', { parent: reader.id, fn: 'notes/write' }))).toBe('notes/read is declared read and tried notes/write, which can write');
    const writer = await runOf('write');
    await rig.grants.check(LINK, 'call', { parent: writer.id, fn: 'notes/read' });
    expect(await refused(rig.grants.check(LINK, 'call', { parent: writer.id, fn: 'notes/wipe' }))).toContain('which can delete');
    expect(await refused(rig.grants.check(LINK, 'propose', { parent: reader.id, fn: 'write', args: {}, key: 'k', approver: 'person' }))).toBe('notes/read is declared read and tried notes/write, which can write');
  });

  it('lets a run ask for the types its fn declares and its own system’s, and no others', async () => {
    await withGrants({ hub: [] });
    const peek = await runOf('peek');
    await rig.grants.check(LINK, 'types', { names: ['database/projects', 'notes/note'], run: peek.id });
    expect(await refused(rig.grants.check(LINK, 'types', { names: ['database/owners'], run: peek.id })))
      .toBe('notes/peek declares the types it reads and writes, and database/owners is not among them');
    // a fn that declares no types is not limited by them
    await rig.grants.check(LINK, 'types', { names: ['database/owners'], run: (await runOf('read')).id });
    expect((await rig.store.table('refusals').find({ where: { system: NOTES, rule: 'types' }, limit: 5 })).items.map((r) => r.fn)).toEqual(['notes/peek']);
  });
});

describe('models and spend', () => {
  it('refuses a model or role not declared, and a run or day past its cap', async () => {
    await withGrants({ hub: ['ai'], models: { roles: ['chat'], models: ['openrouter/free'], perRun: 0.5, perDay: 1 } });
    const run = await runOf('read');
    await rig.grants.check(LINK, 'llm', { run: run.id, request: { messages: [] }, model: { model: 'openrouter/free' }, stream: false });
    expect(await refused(rig.grants.check(LINK, 'llm', { run: run.id, request: { messages: [] }, model: { model: 'openai/gpt-5' }, stream: false }))).toBe('it didn\'t declare that it uses the model openai/gpt-5');
    expect(await refused(rig.grants.check(LINK, 'model', { modality: 'image', prompt: 'a cat', model: { category: 'vision' } }))).toBe('it didn\'t declare that it uses the vision models');
    await rig.store.table('runs').update(run.id, { totalCost: 0.6 });
    expect(await refused(rig.grants.check(LINK, 'llm', { run: run.id, request: { messages: [] }, stream: false }))).toContain('its cap of $0.5000 per run');
    await rig.store.table('ledger').insert({ id: mintId('ledger'), at: rig.time.now, cost: 1.2, tokens: 10, actor: ActorId.parse('act_admin'), system: NOTES, fn: QualifiedName.parse('notes/read'), run: run.id });
    expect(await refused(rig.grants.check(LINK, 'model', { modality: 'speech', text: 'hi' }))).toContain('per day');
  });
});

describe('pausing', () => {
  it('switches a system that keeps going past its grants off, and tells the admins', async () => {
    await withGrants(undefined, 3);
    for (let i = 0; i < 3; i += 1) { await refused(rig.grants.check(LINK, 'llm', {})); }
    expect((await rig.store.table('systems').get(NOTES))?.enabled.functions).toBe(false);
    expect(rig.bus.of('system.paused')).toEqual([{ system: NOTES, refusals: 3 }]);
    expect(await rig.catalog.availability(QualifiedName.parse('notes/read'))).toMatchObject({ unavailable: 'disabled' });
  });
});
