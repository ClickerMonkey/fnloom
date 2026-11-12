import { ApiError } from '@ayepi/core';
import { MAIN_INSTANCE, mintId, QualifiedName, SystemName, type Manifest } from '@harness/core';
import { context, fn, g, kind, system } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { fake } from '../api/testing/rig.ts';
import { refusalPage, systemReview } from '../api/web/review.ts';
import { ADMIN, declOf, manifestFor } from '../catalog/fixtures.ts';
import type { FnsServices } from '../fns/index.ts';
import { clientItemName, contractChanges, foldRuntime, mergeChanges } from './lifecycle.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from './rig.ts';

const NOTES = SystemName.parse('notes');
const q = (name: string): QualifiedName => QualifiedName.parse(name);

/** A small system with no config, a kind and a fn that declares it creates fns of that kind. */
const notes = system('notes', { description: 'Notes.' }).with({
  kinds: { saved: kind({ description: 'A saved note search.', applicability: 'When a search is kept.', payload: g.obj({ text: g.text() }) }) },
  fns: {
    read: fn({ description: 'Read a note.', args: g.obj({ id: g.text() }), returns: g.text(), effects: { mode: 'read' } }),
    write: fn({ description: 'Write a note.', args: g.obj({ id: g.text(), text: g.text() }), returns: g.bool(), effects: { mode: 'write' } }),
    keep: fn({ description: 'Keep a search.', args: g.obj({ text: g.text() }), returns: g.text(), effects: { mode: 'write', registry: [{ thing: 'fns', action: 'create', kind: 'notes/saved' }] } }),
  },
  context: { guide: context({ description: 'How notes work.', content: 'Use @notes/read.' }) },
});

/** Its manifest with a changed fn and a new one: the next contract version. */
function nextVersion(manifest: Manifest): Manifest {
  return {
    ...manifest, version: '1.1.0', hash: `${manifest.hash}-2`,
    fns: [...manifest.fns.map((f) => (f.name === 'write' ? { ...f, description: 'Write a note, now with tags.' } : f)), { ...declOf(manifest, 'read'), name: 'tag', description: 'Tag a note.' }],
  };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    if (error instanceof ApiError) { return { status: error.status, code: error.code }; }
    throw error;
  }
  throw new Error('expected a refusal');
}

let rig: LinkRig;
const started: LinkRig[] = [];
afterEach(async () => { for (const one of started.splice(0)) { await one.stop(); } });

/** A rig, stopped after the test. */
async function newRig(options: Parameters<typeof linkRig>[0] = {}): Promise<LinkRig> {
  rig = await linkRig(options);
  started.push(rig);
  return rig;
}

/** The hash the hub gave the contract it stores for notes (it never keeps the one the system sends). */
async function storedHash(): Promise<string> {
  const stored = await rig.catalog.manifest(NOTES);
  if (stored === undefined) { throw new Error('notes sent no manifest'); }
  return stored.hash;
}

/** The hash of the changes waiting for review. */
async function pendingHash(): Promise<string> {
  const pending = (await rig.lifecycle.review(NOTES))?.pending;
  if (pending === undefined) { throw new Error('nothing waits for review'); }
  return pending.hash;
}

/** A rig that reviews new systems, with notes paired and connected (installed); `hash` is the stored contract's. */
async function installed(): Promise<{ manifest: Manifest; system: FakeSystem; hash: string }> {
  await newRig({ review: { HARNESS_REVIEW_SYSTEMS: true } });
  const manifest = await manifestFor(notes);
  const fake = new FakeSystem(rig.app, 'notes', manifest);
  await pairDirectly(rig, fake);
  await fake.start();
  return { manifest, system: fake, hash: await storedHash() };
}

describe('contract changes', () => {
  it('lists what was added, changed and removed, and folds newer changes onto waiting ones', async () => {
    const manifest = await manifestFor(notes);
    const next = nextVersion(manifest);
    const changes = contractChanges(manifest, next);
    expect(changes.map((c) => [c.section, c.name, c.change])).toEqual([['fns', 'notes/write', 'changed'], ['fns', 'notes/tag', 'added']]);
    // a fn added and then removed before review is no change at all; one changed back is none either
    const back = contractChanges(next, manifest);
    expect(mergeChanges(changes, back)).toEqual([]);
  });

  it('lists each runtime item that went live once, and drops one removed', () => {
    const groceries = { section: 'fns', name: 'notes/groceries', origin: 'runtime' } as const;
    const once = foldRuntime([], [{ ...groceries, change: 'added', after: {} }]);
    const again = foldRuntime(foldRuntime(once, [{ ...groceries, change: 'changed', before: {}, after: { a: 1 } }]), [{ ...groceries, change: 'changed', before: { a: 1 }, after: { a: 2 } }]);
    expect(again).toEqual([{ section: 'fns', name: 'notes/groceries' }]);
    expect(foldRuntime(again, [{ ...groceries, change: 'removed', before: {} }])).toEqual([]);
    // a contract item is not a runtime one
    expect(foldRuntime([], [{ ...groceries, origin: 'contract', change: 'added', after: {} }])).toEqual([]);
  });
});

describe('installed vs live', () => {
  it('offers nothing while installed, then goes live with the reviewed hash and the items kept off', async () => {
    const { hash } = await installed();
    expect((await rig.store.table('systems').get(NOTES))?.stage).toBe('installed');
    expect(await rig.catalog.availability(q('notes/read'))).toEqual({ unavailable: 'disabled', detail: 'notes is installed and waits for an admin to review it and go live' });
    expect((await rig.store.table('context').get(q('notes/guide')))?.systemOff).toBe(true);

    expect(await refusal(rig.lifecycle.goLive({ system: NOTES, hash: 'stale', off: [] }, ADMIN))).toEqual({ status: 409, code: 'CONTRACT_MOVED' });
    expect(await rig.lifecycle.goLive({ system: NOTES, hash, off: [{ section: 'fns', name: 'notes/write' }] }, ADMIN)).toEqual({ stage: 'live', hash });
    expect(await rig.catalog.availability(q('notes/read'))).toBe(true);
    expect(await rig.catalog.availability(q('notes/write'))).toMatchObject({ unavailable: 'disabled' });
    expect((await rig.store.table('context').get(q('notes/guide')))?.systemOff).toBe(false);
    expect((await rig.lifecycle.review(NOTES))?.live).toMatchObject({ hash, version: '1.0.0', by: ADMIN, grants: { hub: [] } });
    expect(await rig.lifecycle.offItems(NOTES)).toEqual([{ section: 'fns', name: 'notes/write' }]);
  });

  it('gives the review page its stage, contract, switches and refusals, newest first', async () => {
    const { hash } = await installed();
    const facts = fake<FnsServices['facts']>('facts', { facts: () => Promise.reject(new Error('its kind is away')) });
    const hub = { store: rig.store, catalog: rig.catalog, fns: fake<FnsServices>('fns', { facts }), link: rig, log: rig.log, api: { content: { presignDownload: (ref: { hash: string }) => Promise.resolve(`https://files.test/${ref.hash}`) } } };
    await expect(systemReview(hub, SystemName.parse('ghost'))).rejects.toMatchObject({ status: 404 });
    expect(await systemReview(hub, NOTES)).toMatchObject({ system: NOTES, stage: 'installed', manifest: { hash }, facts: [], off: [], refusals: { total: 0, last: [] } });

    await rig.lifecycle.goLive({ system: NOTES, hash, off: [{ section: 'fns', name: 'notes/write' }] }, ADMIN);
    for (const [at, rule] of [[1, 'capability'], [2, 'mode']] as const) {
      await rig.store.table('refusals').insert({ id: mintId('refusal'), system: NOTES, instance: MAIN_INSTANCE, rule, attempt: 'llm', detail: `refused ${rule}`, at });
    }
    const review = await systemReview(hub, NOTES);
    expect(review).toMatchObject({ stage: 'live', live: { hash }, off: [{ section: 'fns', name: 'notes/write' }], refusals: { total: 2 } });
    expect(review.refusals.last.map((r) => r.rule)).toEqual(['mode', 'capability']);
    expect((await refusalPage(rig, { system: NOTES, rule: 'mode' })).items.map((r) => r.detail)).toEqual(['refused mode']);
    const first = await refusalPage(rig, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next).toBeDefined();
  });

  it('holds a new contract version for review while the rest keeps working, then approves it', async () => {
    const { manifest, system: fake, hash } = await installed();
    await rig.lifecycle.goLive({ system: NOTES, hash, off: [] }, ADMIN);
    const next = nextVersion(manifest);
    await fake.sdk.call('manifest', next);
    const pending = (await rig.lifecycle.review(NOTES))?.pending;
    expect(pending).toMatchObject({ version: '1.1.0', hash: await storedHash(), by: 'contract' });
    expect(pending?.changes.map((c) => c.name)).toEqual(['notes/write', 'notes/tag']);
    expect(await rig.catalog.availability(q('notes/read'))).toBe(true);
    expect(await rig.catalog.availability(q('notes/tag'))).toMatchObject({ unavailable: 'disabled', detail: 'notes/tag changed and waits for an admin to approve it' });
    expect(await rig.catalog.availability(q('notes/write'))).toMatchObject({ unavailable: 'disabled' });

    expect(await refusal(rig.lifecycle.approve({ system: NOTES, hash, off: [] }, ADMIN))).toEqual({ status: 409, code: 'CONTRACT_MOVED' });
    expect(await refusal(rig.lifecycle.approve({ system: NOTES, hash: next.hash, off: [] }, ADMIN))).toEqual({ status: 409, code: 'CONTRACT_MOVED' });
    await rig.lifecycle.approve({ system: NOTES, hash: await pendingHash(), off: [{ section: 'fns', name: 'notes/tag' }] }, ADMIN);
    expect((await rig.lifecycle.review(NOTES))?.pending).toBeUndefined();
    expect(await rig.catalog.availability(q('notes/write'))).toBe(true);
    expect(await rig.catalog.availability(q('notes/tag'))).toMatchObject({ unavailable: 'disabled', detail: 'notes/tag is switched off' });
  });

  it('enforces the approved grants while more wait for review, and after they are rejected', async () => {
    const { manifest, system: fake, hash } = await installed();
    await rig.lifecycle.goLive({ system: NOTES, hash, off: [] }, ADMIN);
    const asking: Manifest = { ...manifest, hash: `${manifest.hash}-ai`, grants: { hub: ['ai', 'fns'] } };
    await fake.sdk.call('manifest', asking);
    expect((await rig.lifecycle.review(NOTES))?.pending?.changes.map((c) => c.section)).toEqual(['grants']);
    expect(await rig.grants.grants(NOTES)).toEqual({ hub: [] });
    await rig.lifecycle.reject(NOTES, await pendingHash(), ADMIN);
    expect(await rig.grants.grants(NOTES)).toEqual({ hub: [] });
    // asked again and approved, they hold
    const again: Manifest = { ...asking, hash: `${manifest.hash}-ai2`, grants: { hub: ['ai'] } };
    await fake.sdk.call('manifest', again);
    await rig.lifecycle.approve({ system: NOTES, hash: await pendingHash(), off: [] }, ADMIN);
    expect(await rig.grants.grants(NOTES)).toEqual({ hub: ['ai'] });
  });

  it('hashes what it stores, so new content sent under the reviewed hash still waits for review', async () => {
    const { manifest, system: fake, hash } = await installed();
    await rig.lifecycle.goLive({ system: NOTES, hash, off: [] }, ADMIN);
    const sneak: Manifest = { ...manifest, fns: [...manifest.fns, { ...declOf(manifest, 'write'), name: 'sneak', description: 'Delete every note.', effects: { mode: 'delete' } }] };
    await fake.sdk.call('manifest', sneak);
    expect((await rig.lifecycle.review(NOTES))?.pending?.changes.map((c) => [c.name, c.change])).toEqual([['notes/sneak', 'added']]);
    expect(await rig.catalog.availability(q('notes/sneak'))).toMatchObject({ unavailable: 'disabled' });
    expect(await pendingHash()).toBe(await storedHash());
  });

  it('never lets a patch cover itself by declaring the registry effects it needs', async () => {
    const { manifest, system: fake, hash } = await installed();
    await rig.lifecycle.goLive({ system: NOTES, hash, off: [] }, ADMIN);
    const evil = { ...declOf(manifest, 'write'), name: 'evil', description: 'Make anything.', effects: { mode: 'delete' as const, registry: [{ thing: 'fns' as const, action: 'create' as const }, { thing: 'context' as const, action: 'create' as const }] } };
    await fake.sdk.call('patch', { hash: 'anything', upsert: { fns: [evil] }, remove: {} });
    expect((await rig.lifecycle.review(NOTES))?.pending).toMatchObject({ by: 'runtime', changes: [{ name: 'notes/evil', change: 'added', origin: 'runtime' }] });
    expect(await rig.catalog.availability(q('notes/evil'))).toMatchObject({ unavailable: 'disabled' });
    // a fn still waiting covers nothing either
    await fake.sdk.call('patch', { hash: 'more', upsert: { fns: [{ ...evil, name: 'evil2' }] }, remove: {} });
    expect((await rig.lifecycle.review(NOTES))?.pending?.changes.map((c) => c.name)).toEqual(['notes/evil', 'notes/evil2']);
  });

  it('holds a changed client build off until approved', async () => {
    const { manifest, system: fake, hash } = await installed();
    await rig.lifecycle.goLive({ system: NOTES, hash, off: [] }, ADMIN);
    await fake.sdk.call('manifest', { ...manifest, client: { entry: 'index.js', hash: 'build2', files: [] }, events: ['message'] });
    const changes = (await rig.lifecycle.review(NOTES))?.pending?.changes.map((c) => [c.section, c.name, c.change]);
    expect(changes).toEqual([['components', clientItemName(NOTES), 'added'], ['config', 'notes events', 'changed']]);
    expect(await rig.lifecycle.off('components')).toEqual(new Set([clientItemName(NOTES)]));
    await rig.lifecycle.approve({ system: NOTES, hash: await pendingHash(), off: [] }, ADMIN);
    expect(await rig.lifecycle.off('components')).toEqual(new Set());
  });

  it('approves at once a runtime addition a fn declared, and holds one nobody declared', async () => {
    const { manifest, hash } = await installed();
    await rig.lifecycle.goLive({ system: NOTES, hash, off: [] }, ADMIN);
    const saved = { ...declOf(manifest, 'read'), name: 'groceries', kind: q('notes/saved'), payload: { text: 'milk' } };
    const declared: Manifest = { ...manifest, hash: 'h2', fns: [...manifest.fns, saved], runtime: { fns: ['groceries'] } };
    await rig.lifecycle.contractChanged(NOTES, manifest, declared);
    const review = await rig.lifecycle.review(NOTES);
    expect(review?.pending).toBeUndefined();
    expect(review?.live).toMatchObject({ hash: 'h2', runtime: [{ section: 'fns', name: 'notes/groceries' }] });

    // no fn declares that it adds context, so a context item added while running waits for review
    const guide = declared.context.find((item) => item.name === 'guide');
    if (guide === undefined) { throw new Error('no guide'); }
    const undeclared: Manifest = { ...declared, hash: 'h3', context: [...declared.context, { ...guide, name: 'extra' }], runtime: { fns: ['groceries'], context: ['extra'] } };
    await rig.lifecycle.contractChanged(NOTES, declared, undeclared);
    expect((await rig.lifecycle.review(NOTES))?.pending).toMatchObject({ hash: 'h3', by: 'runtime', changes: [{ section: 'context', name: 'notes/extra', change: 'added', origin: 'runtime' }] });
  });

  it('keeps a part switched off until it is switched back on', async () => {
    await newRig();
    const fake = new FakeSystem(rig.app, 'notes', await manifestFor(notes));
    await pairDirectly(rig, fake);
    await fake.start();
    expect((await rig.store.table('systems').get(NOTES))?.stage).toBe('live');
    expect(await rig.lifecycle.switchPart({ system: NOTES, section: 'kinds', name: 'notes/saved', on: false }, ADMIN)).toEqual({ on: false });
    expect(await rig.lifecycle.offItems(NOTES)).toEqual([{ section: 'kinds', name: 'notes/saved' }]);
    expect([...await rig.lifecycle.off('kinds')]).toEqual(['notes/saved']);
    // any part the hub serves by name (a hook, mention, action, sectioner, …) reads as off where it is offered
    expect(await rig.catalog.availability(q('notes/saved'))).toEqual({ unavailable: 'disabled', detail: 'notes/saved is switched off' });
    await rig.lifecycle.switchPart({ system: NOTES, section: 'kinds', name: 'notes/saved', on: true }, ADMIN);
    expect(await rig.lifecycle.offItems(NOTES)).toEqual([]);
    expect(await rig.catalog.availability(q('notes/saved'))).toBe(true);
  });
});
