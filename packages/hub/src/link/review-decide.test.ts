/**
 * The Pending tab's hub side: what a pending review's changes amount to (`reviewSummary`, its risk flags and each
 * changed fn's facts), approving or declining it change by change (`SystemLifecycle.decide`, `decideReview`), and the
 * install card's summary worked out from the contract its host sent (`installCard`).
 */
import { ApiError } from '@ayepi/core';
import { MAIN_INSTANCE, QualifiedName, SystemName, type ApprovalPreview, type ContractChange, type InstallSubject, type Manifest } from '@harness/core';
import { context, contractHash, fn, g, system } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { fake } from '../api/testing/rig.ts';
import { systemReview } from '../api/web/review.ts';
import { ADMIN, declOf, manifestFor } from '../catalog/fixtures.ts';
import type { FnsServices } from '../fns/index.ts';
import { installCard } from './install.ts';
import { contractChanges } from './lifecycle.ts';
import { fnChangeFacts, grantsMove, reviewSummary } from './review-summary.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig } from './rig.ts';

const NOTES = SystemName.parse('notes');
const q = (name: string): QualifiedName => QualifiedName.parse(name);

const notes = system('notes', { description: 'Notes.' }).with({
  fns: {
    read: fn({ description: 'Read a note.', args: g.obj({ id: g.text() }), returns: g.text(), effects: { mode: 'read' } }),
    write: fn({ description: 'Write a note.', args: g.obj({ id: g.text(), text: g.text() }), returns: g.bool(), effects: { mode: 'write' } }),
  },
  context: { guide: context({ description: 'How notes work.', content: 'Use @notes/read.' }) },
});

/** The next version: `read` now deletes, a new `tag` fn writes, `guide` reads differently, and it asks for more grants. */
function nextVersion(manifest: Manifest): Manifest {
  return {
    ...manifest, version: '1.1.0', hash: `${manifest.hash}-2`,
    grants: { hub: ['ai'], network: ['api.example.com'], secrets: ['NOTES_TOKEN'] },
    fns: [
      ...manifest.fns.map((f) => (f.name === 'read' ? { ...f, description: 'Read a note, then drop it.', effects: { mode: 'delete' as const, registry: [{ thing: 'context' as const, action: 'remove' as const }] } } : f)),
      { ...declOf(manifest, 'write'), name: 'tag', description: 'Tag a note.' },
    ],
    context: manifest.context.map((item) => (item.name === 'guide' ? { ...item, content: 'Use @notes/read, then @notes/tag.' } : item)),
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

/** Notes paired, live, then sent its next version: what waits for review, and its hash. */
async function pendingNext(): Promise<{ manifest: Manifest; hash: string }> {
  rig = await linkRig({ review: { HARNESS_REVIEW_SYSTEMS: true } });
  started.push(rig);
  const manifest = await manifestFor(notes);
  const sys = new FakeSystem(rig.app, 'notes', manifest);
  await pairDirectly(rig, sys);
  await sys.start();
  const stored = await rig.catalog.manifest(NOTES);
  if (stored === undefined) { throw new Error('notes sent no manifest'); }
  await rig.lifecycle.goLive({ system: NOTES, hash: stored.hash, off: [] }, ADMIN);
  await sys.sdk.call('manifest', nextVersion(manifest));
  const pending = (await rig.lifecycle.review(NOTES))?.pending;
  if (pending === undefined) { throw new Error('nothing waits'); }
  return { manifest, hash: pending.hash };
}

const ref = (section: ContractChange['section'], name: string) => ({ section, name });

describe('a pending review in one strip', () => {
  it('counts each section, says how the grants and config moved, and flags the risks first', async () => {
    const manifest = await manifestFor(notes);
    const summary = reviewSummary(contractChanges(manifest, nextVersion(manifest)));
    expect(summary.line).toBe('+1 fn, 1 changed, 1 context item changed, grants widened');
    expect(summary.grants).toBe('widened');
    expect(summary.flags.map((flag) => [flag.flag, flag.items])).toEqual([
      ['delete-fns', ['notes/read']], ['write-fns', ['notes/tag']], ['effects', ['notes/read']],
      ['capabilities', ['ai']], ['secrets', ['NOTES_TOKEN']], ['hosts', ['api.example.com']],
    ]);
    expect(summary.flags.find((flag) => flag.flag === 'effects')?.line).toBe('New effects in notes/read: Removes context');
    // each flag carries the parts its line is written from, so a view draws the fns as pills between the same words
    expect(summary.flags.find((flag) => flag.flag === 'effects')).toMatchObject({ lead: 'New effects in', tail: 'Removes context' });
    expect(summary.flags.find((flag) => flag.flag === 'delete-fns')).toMatchObject({ lead: 'Can delete', line: 'Can delete: notes/read' });
    expect(summary.flags.find((flag) => flag.flag === 'delete-fns')?.tail).toBeUndefined();
  });

  it('says a config type changed and a fresh install adds everything', async () => {
    const manifest = await manifestFor(notes);
    const configured: Manifest = { ...manifest, hash: 'h2', config: g.obj({ token: g.text() }).toJSON() };
    expect(reviewSummary(contractChanges(manifest, configured)).line).toBe('config type changed');
    const fresh = reviewSummary(contractChanges(undefined, manifest));
    expect(fresh.line).toBe('+2 fns, +1 context item, grants added, config type added, hub events added, resource serving added');
    expect(fresh.flags.map((flag) => flag.flag)).toEqual(['write-fns']);
    expect(reviewSummary([]).line).toBe('No changes');
  });

  it('reads narrowed and mixed grants, and spend raised or a role limit lifted as wider', () => {
    expect(grantsMove({ hub: ['ai', 'fns'] }, { hub: ['ai'] }).move).toBe('narrowed');
    expect(grantsMove({ hub: ['fns'] }, { hub: ['ai'] }).move).toBe('changed');
    expect(grantsMove({ hub: [], models: { roles: ['chat'], perRun: 1 } }, { hub: [], models: { perRun: 2 } }).flags).toEqual([
      { flag: 'models', line: 'New models: any role, more spend a run', items: ['any role', 'more spend a run'], lead: 'New models' },
    ]);
  });

  it('gives each changed fn its declared facts before and after', async () => {
    const manifest = await manifestFor(notes);
    const facts = fnChangeFacts(contractChanges(manifest, nextVersion(manifest)));
    expect(facts.map((f) => [f.name, f.before?.mode, f.after?.mode])).toEqual([['notes/read', 'read', 'delete'], ['notes/tag', undefined, 'write']]);
    expect(facts[0]?.after?.effects).toBe('Removes context.');
  });
});

describe('approving or declining a pending review change by change', () => {
  it('puts approved changes live, keeps declined ones off and recorded, and leaves the rest waiting', async () => {
    const { hash } = await pendingNext();
    expect(await rig.catalog.availability(q('notes/tag'))).toMatchObject({ unavailable: 'held' });
    const first = await rig.lifecycle.decide({ system: NOTES, hash, approve: [ref('fns', 'notes/tag')], decline: [ref('fns', 'notes/read')], off: [] }, ADMIN);
    expect(first.waiting).toBe(2);
    expect(await rig.catalog.availability(q('notes/tag'))).toBe(true);
    expect(await rig.catalog.availability(q('notes/read'))).toMatchObject({ unavailable: 'disabled' });
    const review = await rig.lifecycle.review(NOTES);
    expect(review?.pending?.changes.map((c) => c.section)).toEqual(['context', 'grants']);
    expect(review?.pending?.hash).toBe(hash);
    expect(review?.declined).toMatchObject([{ section: 'fns', name: 'notes/read', change: 'changed', version: '1.1.0', by: ADMIN }]);
    // the grants wait, so the live ones still hold; the live hash is still the old one
    expect(await rig.grants.grants(NOTES)).toEqual({ hub: [] });
    expect(review?.live?.hash).not.toBe(hash);

    const last = await rig.lifecycle.decide({ system: NOTES, hash, approve: [ref('grants', 'notes')], decline: [ref('context', 'notes/guide')], off: [] }, ADMIN);
    expect(last).toEqual({ hash, waiting: 0 });
    const done = await rig.lifecycle.review(NOTES);
    expect(done?.pending).toBeUndefined();
    expect(done?.live).toMatchObject({ hash, version: '1.1.0' });
    expect(done?.declined?.map((d) => d.name)).toEqual(['notes/guide', 'notes/read']);
    expect(await rig.grants.grants(NOTES)).toEqual({ hub: ['ai'], network: ['api.example.com'], secrets: ['NOTES_TOKEN'] });
    expect((await rig.store.table('context').get(q('notes/guide')))?.disabled).toBe(true);
  });

  it('keeps an approved item off when asked, and refuses a moved hash, an unknown change or one decided twice', async () => {
    const { hash } = await pendingNext();
    expect(await refusal(rig.lifecycle.decide({ system: NOTES, hash: 'old', approve: [ref('fns', 'notes/tag')], decline: [], off: [] }, ADMIN))).toEqual({ status: 409, code: 'CONTRACT_MOVED' });
    expect(await refusal(rig.lifecycle.decide({ system: NOTES, hash, approve: [ref('fns', 'notes/write')], decline: [], off: [] }, ADMIN))).toEqual({ status: 409, code: 'NOT_PENDING' });
    expect(await refusal(rig.lifecycle.decide({ system: NOTES, hash, approve: [ref('fns', 'notes/tag')], decline: [ref('fns', 'notes/tag')], off: [] }, ADMIN))).toEqual({ status: 400, code: 'DECIDED_TWICE' });
    await rig.lifecycle.decide({ system: NOTES, hash, approve: [ref('fns', 'notes/tag')], decline: [], off: [{ section: 'fns', name: 'notes/tag' }] }, ADMIN);
    expect(await rig.catalog.availability(q('notes/tag'))).toMatchObject({ unavailable: 'disabled' });
    expect((await rig.lifecycle.review(NOTES))?.pending?.changes.some((c) => c.name === 'notes/tag')).toBe(false);
    // approving the rest at once still works on what is left
    await rig.lifecycle.approve({ system: NOTES, hash, off: [] }, ADMIN);
    expect((await rig.lifecycle.review(NOTES))?.pending).toBeUndefined();
  });

  it('records what a reject-all declined', async () => {
    const { hash } = await pendingNext();
    await rig.lifecycle.reject(NOTES, hash, ADMIN);
    expect((await rig.lifecycle.review(NOTES))?.declined?.map((d) => d.name)).toEqual(['notes/read', 'notes/tag', 'notes/guide', 'notes']);
  });

  it('gives the review page the summary, each changed fn\'s facts and what was declined', async () => {
    const { hash } = await pendingNext();
    await rig.lifecycle.decide({ system: NOTES, hash, approve: [], decline: [ref('fns', 'notes/tag')], off: [] }, ADMIN);
    const facts = fake<FnsServices['facts']>('facts', { facts: () => Promise.reject(new Error('not needed')) });
    const hub = { store: rig.store, catalog: rig.catalog, fns: fake<FnsServices>('fns', { facts }), link: rig, log: rig.log, api: { content: { presignDownload: () => Promise.resolve('') } } };
    const review = await systemReview(hub, NOTES);
    expect(review.pending?.summary.line).toBe('1 fn changed, 1 context item changed, grants widened');
    expect(review.pending?.fns.map((f) => f.name)).toEqual(['notes/read']);
    expect(review.declined.map((d) => d.name)).toEqual(['notes/tag']);
  });
});

describe('an install card\'s summary', () => {
  const host = { system: SystemName.parse('fs'), instance: MAIN_INSTANCE };

  async function card(manifest: Manifest): Promise<ApprovalPreview> {
    const subject: InstallSubject = { kind: 'system-install', system: NOTES, instance: MAIN_INSTANCE, version: manifest.version, manifestHash: await contractHash(manifest), bundleHash: 'b', sourceHash: 's', host };
    return { title: 'Install notes', parts: [], irreversible: false, subject };
  }

  it('says what the contract adds over the one the hub has, and refuses a contract the subject does not bind', async () => {
    rig = await linkRig({});
    started.push(rig);
    const manifest = await manifestFor(notes);
    const lookups = { instance: () => Promise.resolve(undefined), manifest: (name: SystemName) => rig.catalog.manifest(name) };
    const fresh = await installCard({ preview: await card(manifest), contract: manifest }, {}, lookups);
    expect('preview' in fresh ? fresh.preview.summary?.line : '').toMatch(/^\+2 fns, \+1 context item, grants added/);
    expect('preview' in fresh && 'contract' in fresh.preview).toBe(false);

    const next = nextVersion(manifest);
    const upgrade = await installCard({ preview: await card(next), contract: next }, {}, { ...lookups, manifest: () => Promise.resolve(manifest) });
    expect('preview' in upgrade ? upgrade.preview.summary?.flags.map((flag) => flag.flag) : []).toContain('delete-fns');

    const wrong = await installCard({ preview: await card(manifest), contract: next }, {}, lookups);
    expect('refused' in wrong ? wrong.refused : '').toMatch(/not the one it installs/);
    // the hub hashes what was sent: a contract with other fns under the bound hash is refused too
    const forged = await installCard({ preview: await card(manifest), contract: { ...next, version: manifest.version, hash: manifest.hash } }, {}, lookups);
    expect('refused' in forged ? forged.refused : '').toMatch(/not the one it installs/);
    // a host that sends no contract gets its card as it was
    expect(await installCard({ preview: await card(manifest) }, {}, lookups)).toEqual({ preview: await card(manifest) });
  });
});
