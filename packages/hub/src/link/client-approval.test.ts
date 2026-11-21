/**
 * H3: a system's client build (its renderers, pages and config component, which run in the browser as the admin) is
 * served at `/clients/<system>/<build>/…` and offered to the web only once an admin approved that very build: by going
 * live, or by approving the change to it. A newly paired system (installed, never reviewed) gets nothing served, and a
 * changed build waits as its review does. Over the real lifecycle, store and file route.
 */
import { createServer, type Server } from 'node:http';
import { SystemName, type Manifest } from '@harness/core';
import { fn, g, system } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientBuildRoute } from '../api/serve.ts';
import { clientUrl } from '../api/web/chat.ts';
import { systemReview } from '../api/web/review.ts';
import { fake } from '../api/testing/rig.ts';
import { ADMIN, manifestFor } from '../catalog/fixtures.ts';
import type { FnsServices } from '../fns/index.ts';
import { FakeSystem, linkRig, pairDirectly, type LinkRig, type MemoryContent } from './rig.ts';

const NOTES = SystemName.parse('notes');
const notes = system('notes', { description: 'Notes.' }).with({
  fns: { read: fn({ description: 'Read a note.', args: g.obj({ id: g.text() }), returns: g.text(), effects: { mode: 'read' } }) },
});

const servers: Server[] = [];
const rigs: LinkRig[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { await new Promise((resolve) => { server.close(resolve); }); }
  for (const rig of rigs.splice(0)) { await rig.stop(); }
});

/** A contract with a client build of one file, whose bytes are in `content`. */
async function withBuild(manifest: Manifest, content: MemoryContent, build: string, code: string): Promise<Manifest> {
  const file = await content.put(new TextEncoder().encode(code), 'text/javascript');
  return { ...manifest, client: { entry: 'index.js', hash: build, files: [{ path: 'index.js', size: file.size, hash: file.hash }] }, configComponent: { component: 'NotesConfig', mode: 'replace' } };
}

/** The rig, notes paired and connected with a build, and the client route served over HTTP. */
async function start(review: boolean) {
  const rig = await linkRig({ review: { HARNESS_REVIEW_SYSTEMS: review } });
  rigs.push(rig);
  const manifest = await withBuild(await manifestFor(notes), rig.content, 'build1', 'export default "one"');
  const notesSystem = new FakeSystem(rig.app, 'notes', manifest);
  await pairDirectly(rig, notesSystem);
  await notesSystem.start();
  const route = new ClientBuildRoute({ content: { open: (hash) => rig.content.open(hash) }, lifecycle: () => rig.lifecycle });
  const server = createServer((req, res) => {
    void route.serve(req, res, new URL(req.url ?? '/', 'http://x').pathname).then((done) => { if (!done) { res.writeHead(404).end(); } });
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const status = async (build: string): Promise<number> => (await fetch(`${base}${clientUrl(NOTES, build, 'index.js')}`)).status;
  const hash = async (): Promise<string> => (await rig.catalog.manifest(NOTES))?.hash ?? '';
  const facts = fake<FnsServices['facts']>('facts', { facts: () => Promise.reject(new Error('none')) });
  const reviewed = async () => systemReview({ store: rig.store, catalog: rig.catalog, log: rig.log, fns: fake<FnsServices>('fns', { facts }), link: rig, api: { content: { presignDownload: () => Promise.resolve('') } } }, NOTES);
  return { rig, manifest, notesSystem, status, hash, reviewed };
}

describe('client builds load only after approval', () => {
  it("serves nothing of a newly paired system's build until an admin reviews it and it goes live", async () => {
    const { rig, status, hash, reviewed } = await start(true);
    expect((await rig.store.table('systems').get(NOTES))?.stage).toBe('installed');
    // the attack: a peer that got paired has its build loaded in the admin's browser before anyone reviewed it
    expect(await status('build1')).toBe(404);
    expect(await rig.lifecycle.approvedClient(NOTES)).toBeUndefined();
    expect((await reviewed()).clientApproved).toBe(false);

    await rig.lifecycle.goLive({ system: NOTES, hash: await hash(), off: [] }, ADMIN);
    expect(await status('build1')).toBe(200);
    expect((await reviewed()).clientApproved).toBe(true);
  });

  it('holds a changed build back until its change is approved, and never serves the old one in its place', async () => {
    const { rig, manifest, notesSystem, status, hash } = await start(true);
    await rig.lifecycle.goLive({ system: NOTES, hash: await hash(), off: [] }, ADMIN);
    const next = await withBuild(manifest, rig.content, 'build2', 'export default "two"');
    await notesSystem.sdk.call('manifest', { ...next, version: '1.1.0' });
    expect(await status('build2')).toBe(404);
    expect(await status('build1')).toBe(404);
    const pending = (await rig.lifecycle.review(NOTES))?.pending?.hash ?? '';
    await rig.lifecycle.approve({ system: NOTES, hash: pending, off: [] }, ADMIN);
    expect(await status('build2')).toBe(200);
  });

  it('serves a build an admin switched off no more, and one declined never', async () => {
    const { rig, manifest, notesSystem, status, hash } = await start(true);
    await rig.lifecycle.goLive({ system: NOTES, hash: await hash(), off: [] }, ADMIN);
    await rig.lifecycle.switchPart({ system: NOTES, section: 'components', name: 'notes: client build', on: false }, ADMIN);
    expect(await status('build1')).toBe(404);
    await rig.lifecycle.switchPart({ system: NOTES, section: 'components', name: 'notes: client build', on: true }, ADMIN);
    expect(await status('build1')).toBe(200);
    await notesSystem.sdk.call('manifest', { ...await withBuild(manifest, rig.content, 'build3', 'export default "three"'), version: '1.2.0' });
    const pending = (await rig.lifecycle.review(NOTES))?.pending?.hash ?? '';
    await rig.lifecycle.reject(NOTES, pending, ADMIN);
    expect(await status('build3')).toBe(404);
  });

  it('serves a build at once on a hub that does not review systems', async () => {
    const { status } = await start(false);
    expect(await status('build1')).toBe(200);
  });
});
