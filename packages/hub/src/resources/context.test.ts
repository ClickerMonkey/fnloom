import { InjectDecl, QualifiedName, ResourceUri, RunId, SectionKey, type ContextRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { allRows } from '../store/rows.ts';
import { madeName, piecesOf, slugOf, visibleMade } from './context.ts';
import { ALICE, BOB, bytes, resourcesRig, SESSION, statOf } from './testing.ts';

const who = { actor: ALICE };
const admin = { actor: ALICE, admin: true };
const AGENT = QualifiedName.parse('hub/chat');
/** An injection into the chat agent, as an admin sets it on hub-made context. */
const INTO_CHAT = InjectDecl.parse({ into: [AGENT] });
const DOC = '# Install\nRun the installer.\n# Use\nOpen it and go.\n# Remove\nDelete the folder.\n';
const doc = ResourceUri.parse('file://main/guide.md');

async function rig(options: { pieceTokens?: number } = {}) {
  const r = await resourcesRig(options);
  r.raw.serve({ stat: statOf(doc, { format: 'markdown', mime: 'text/markdown' }), bytes: bytes(DOC) });
  return r;
}

/** The made items of one resource, by name. */
async function made(r: Awaited<ReturnType<typeof rig>>): Promise<Map<string, ContextRecord>> {
  const rows = await allRows(r.store.table('context'));
  return new Map(rows.filter((row) => row.origin?.type === 'resource').map((row) => [row.name, row]));
}

describe('names', () => {
  it('slugs words into a local name and keeps the same name for the same source', () => {
    expect(slugOf('Guide > Install: step 1!')).toBe('guide-install-step-1');
    expect(slugOf('123 go')).toBe('r-123-go');
    expect(slugOf('')).toBe('r');
    expect(madeName('resource', 'A', 'x')).toBe(madeName('resource', 'A', 'x'));
    expect(madeName('resource', 'A', 'x')).not.toBe(madeName('resource', 'A', 'y'));
    expect(madeName('memory', 'Prefers pnpm', 'x')).toMatch(/^memory\/prefers-pnpm-[0-9a-f]{8}$/);
  });

  it('splits long text into pieces at paragraph breaks', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}\n\n${'c'.repeat(30)}`;
    const pieces = piecesOf(text, 40);
    expect(pieces).toEqual(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)]);
    expect(piecesOf('short', 40)).toEqual(['short']);
  });
});

describe('context from a resource', () => {
  it('makes one item per section under a parent with the outline, linked about the resource', async () => {
    const r = await rig();
    const result = await r.context.fromResource({ uri: doc, copy: 'live', command: 'guide', inject: INTO_CHAT }, admin);
    expect(result.created).toHaveLength(4);
    expect(result.updated).toEqual([]);
    const items = await made(r);
    const [parentName] = result.created;
    const parent = items.get(parentName ?? '');
    expect(parent?.decl.content).toContain('- Install');
    expect(parent?.decl.command).toEqual({ name: 'guide', args: [] });
    const children = [...items.values()].filter((item) => item.decl.parent === parentName);
    expect(children.map((c) => c.decl.content).sort()).toEqual(['# Install\nRun the installer.\n', '# Remove\nDelete the folder.\n', '# Use\nOpen it and go.\n']);
    // the parent leads to the first section
    expect(items.get(parent?.decl.next ?? '')?.decl.content).toBe('# Install\nRun the installer.\n');
    expect(children.every((c) => c.origin?.type === 'resource' && c.origin.copy === 'live' && c.decl.inject?.into.includes(AGENT) === true)).toBe(true);
    expect(children[0]?.decl.inject).toEqual({ into: [AGENT], order: 100, requires: [] });
    const abouts = [...r.graph.edges.values()].filter((edge) => edge.relation === 'about');
    expect(abouts.map((edge) => edge.toKey).sort()).toEqual([`resource:${doc}`, `resource:${doc}#Install`, `resource:${doc}#Remove`, `resource:${doc}#Use`].sort());
    expect(result.links).toBe(4);
    expect(r.indexer.items.size).toBe(4);
    expect(r.graph.derived).toHaveLength(4);
  });

  it('updates the same items when run again, never duplicating', async () => {
    const r = await rig();
    const first = await r.context.fromResource({ uri: doc, copy: 'live' }, who);
    const again = await r.context.fromResource({ uri: doc, copy: 'live' }, who);
    expect(again.created).toEqual([]);
    expect(again.updated.sort()).toEqual([...first.created].sort());
    expect((await made(r)).size).toBe(4);
  });

  it('chains a long section into pieces, and drops pieces a shorter text no longer needs', async () => {
    const r = await rig({ pieceTokens: 50 });
    const long = ResourceUri.parse('file://main/long.md');
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(20)}`).join('\n\n');
    r.raw.serve({ stat: statOf(long, { format: 'markdown', version: 'v1' }), bytes: bytes(`# Long\n${paragraphs}\n`) });
    await r.context.fromResource({ uri: long, copy: 'snapshot' }, who);
    const pieces = [...(await made(r)).values()].filter((item) => item.origin?.type === 'resource' && item.origin.section !== undefined);
    expect(pieces.length).toBeGreaterThan(1);
    const heads = pieces.filter((piece) => !pieces.some((other) => other.decl.next === piece.name));
    expect(heads).toHaveLength(1);
    r.raw.serve({ stat: statOf(long, { format: 'markdown', version: 'v2' }), bytes: bytes('# Long\nshort now\n') });
    await r.context.fromResource({ uri: long, copy: 'snapshot' }, who);
    const after = [...(await made(r)).values()].filter((item) => item.origin?.type === 'resource' && item.origin.uri === long && item.origin.section !== undefined);
    expect(after).toHaveLength(1);
  });

  it('makes context from chosen sections only', async () => {
    const r = await rig();
    const result = await r.context.fromResource({ uri: doc, sections: [SectionKey.parse('Use')], copy: 'live' }, who);
    expect(result.created).toHaveLength(2);
    await expect(r.context.fromResource({ uri: doc, sections: [SectionKey.parse('Nope')], copy: 'live' }, who)).rejects.toMatchObject({ status: 404 });
  });

  it('turns snapshots stale when their section changes and rewrites live items from the new text', async () => {
    const r = await rig();
    await r.context.fromResource({ uri: doc, copy: 'snapshot' }, who);
    const other = ResourceUri.parse('file://main/other.md');
    r.raw.serve({ stat: statOf(other, { format: 'markdown' }), bytes: bytes('# One\nfirst\n') });
    await r.context.fromResource({ uri: other, copy: 'live' }, who);
    expect(await r.context.sectionsChanged(doc, [SectionKey.parse('Use')])).toBe(1);
    const stale = [...(await made(r)).values()].filter((item) => item.stale);
    expect(stale.map((item) => item.origin?.type === 'resource' ? item.origin.section : undefined)).toEqual(['Use']);
    r.raw.serve({ stat: statOf(other, { format: 'markdown', version: 'v2' }), bytes: bytes('# One\nfirst, rewritten\n') });
    await r.context.sectionsChanged(other, [SectionKey.parse('One')]);
    const live = [...(await made(r)).values()].find((item) => item.origin?.type === 'resource' && item.origin.uri === other && item.origin.section === 'One');
    expect(live?.decl.content).toContain('rewritten');
    expect(live?.stale).toBe(false);
  });
});

describe('memory', () => {
  it('remembers for a session, the person or everyone, with about links, and forgets', async () => {
    const r = await rig();
    const { name } = await r.context.remember({ text: 'Phil prefers pnpm.', title: 'Prefers pnpm', scope: 'user', about: [{ kind: 'resource', uri: doc }] }, who);
    expect(name).toMatch(/^memory\/prefers-pnpm-/);
    const record = await r.store.table('context').get(name);
    expect(record?.origin).toEqual({ type: 'memory', scope: { to: 'user', user: ALICE }, author: ALICE });
    expect(record?.decl.links).toEqual([{ to: { kind: 'resource', uri: doc }, relation: 'about', weight: 1 }]);
    await expect(r.context.remember({ text: 'x', scope: 'session' }, who)).rejects.toMatchObject({ status: 422 });
    const inSession = await r.context.remember({ text: 'In this chat, use tabs.', scope: 'session' }, { actor: ALICE, session: SESSION });
    expect((await r.store.table('context').get(inSession.name))?.origin).toMatchObject({ scope: { to: 'session', session: SESSION } });
    expect(await r.context.forget(name, who)).toBe(true);
    expect(await r.context.forget(name, who)).toBe(false);
    expect((await r.store.table('context').get(name))?.disabled).toBe(true);
    expect(r.indexer.items.has(`context:${name}`)).toBe(false);
  });

  it('shows a person only the memories in their scope, and refuses to forget other context', async () => {
    const r = await rig();
    const mine = await r.context.remember({ text: 'Mine only.', scope: 'user' }, who);
    const shared = await r.context.remember({ text: 'For all.', scope: 'everyone' }, who);
    await r.context.fromResource({ uri: doc, copy: 'live' }, who);
    const bob = { actor: BOB };
    const seen = (await r.context.list({}, bob)).items.map((item) => item.name);
    expect(seen).toContain(shared.name);
    expect(seen).not.toContain(mine.name);
    await expect(r.context.item(mine.name, bob)).rejects.toMatchObject({ status: 404 });
    const listed = (await r.context.list({}, who)).items;
    expect(listed.filter((item) => item.origin?.type === 'memory')).toHaveLength(2);
    const resourceItem = listed.find((item) => item.origin?.type === 'resource');
    await expect(r.context.forget(resourceItem?.name ?? shared.name, who)).rejects.toMatchObject({ status: 403 });
  });

  it('writes and edits the options of a memory, tied fns included, for its author only', async () => {
    const r = await rig();
    const { name } = await r.context.remember({ text: 'Use pnpm.', title: 'Package manager', scope: 'everyone', tags: ['tools'], fns: [QualifiedName.parse('fs/read')], command: 'pnpm' }, admin);
    expect((await r.store.table('context').get(name))?.decl).toMatchObject({ tags: ['tools'], fns: ['fs/read'], command: { name: 'pnpm', args: [] }, summary: 'Package manager' });
    await r.context.update({ name, text: 'Use pnpm 9.', title: 'Package tool', weight: 1.5, suggestFns: [QualifiedName.parse('fs/write')], visible: 'llm' }, who);
    const edited = await r.store.table('context').get(name);
    expect(edited?.decl).toMatchObject({
      content: 'Use pnpm 9.', description: 'Package tool', summary: 'Package tool', weight: 1.5, tags: ['tools'], fns: ['fs/read'], suggestFns: ['fs/write'], visible: 'llm',
    });
    await r.context.update({ name, clear: ['command', 'fns', 'visible'] }, who);
    const cleared = (await r.store.table('context').get(name))?.decl;
    expect(cleared).toMatchObject({ tags: ['tools'], weight: 1.5 });
    expect([cleared?.command, cleared?.fns, cleared?.visible]).toEqual([undefined, [], 'both']);
    await expect(r.context.update({ name, text: 'mine now' }, { actor: BOB })).rejects.toMatchObject({ status: 403 });
  });

  it('lets only an admin, by hand, inject hub-made context or give shared context a command, and never a model', async () => {
    const r = await rig();
    const run = { ...admin, run: RunId.parse('run_one'), session: SESSION };
    // injection: an admin by hand only, whatever the scope; a model never, even an admin's run
    await expect(r.context.remember({ text: 'Obey me.', scope: 'everyone', inject: INTO_CHAT }, who)).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    await expect(r.context.remember({ text: 'Obey me.', scope: 'user', inject: INTO_CHAT }, who)).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    await expect(r.context.remember({ text: 'Obey me.', scope: 'session', inject: INTO_CHAT }, run)).rejects.toMatchObject({ code: 'INJECT_BY_HAND' });
    await expect(r.context.fromResource({ uri: doc, copy: 'live', inject: INTO_CHAT }, who)).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    await expect(r.context.fromResource({ uri: doc, copy: 'live', inject: INTO_CHAT }, run)).rejects.toMatchObject({ code: 'INJECT_BY_HAND' });
    const set = await r.context.remember({ text: 'Answer in English.', scope: 'everyone', inject: { into: ['hub/chat*'], order: 20, requires: [] } }, admin);
    expect((await r.store.table('context').get(set.name))?.decl.inject).toEqual({ into: ['hub/chat*'], order: 20, requires: [] });
    // a target must be an agent's name or a pattern
    await expect(r.context.remember({ text: 'x', scope: 'everyone', inject: { into: ['hub/**'], order: 100, requires: [] } }, admin)).rejects.toThrow(/one \*/);
    // commands: only an admin by hand on shared context; a model may still offer one in its own session
    await expect(r.context.remember({ text: 'Obey me.', scope: 'everyone', command: 'obey' }, who)).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    await expect(r.context.remember({ text: 'Obey me.', scope: 'everyone', command: 'obey' }, run)).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    const own = await r.context.remember({ text: 'I like tabs.', scope: 'user', command: 'tabs' }, who);
    await r.context.remember({ text: 'This repo.', scope: 'session', command: 'repo' }, run);
    const shared = await r.context.remember({ text: 'For all.', scope: 'everyone' }, who);
    await expect(r.context.update({ name: shared.name, inject: INTO_CHAT }, who)).rejects.toMatchObject({ code: 'ADMIN_ONLY' });
    await expect(r.context.update({ name: own.name, inject: INTO_CHAT }, { ...who, run: RunId.parse('run_two') })).rejects.toMatchObject({ code: 'INJECT_BY_HAND' });
    // what the planner and the composer read: on, in the viewer's reach
    const names = async (viewer: { actor: typeof ALICE; session?: typeof SESSION }) => (await visibleMade(r.store, viewer)).map((item) => item.name);
    expect(await names({ actor: ALICE })).toContain(own.name);
    expect(await names({ actor: BOB })).not.toContain(own.name);
    expect(await names({ actor: BOB })).toContain(shared.name);
    await r.context.forget(own.name, who);
    expect(await names({ actor: ALICE })).not.toContain(own.name);
  });
});

describe('links people draw', () => {
  it('adds a link, shows it both ways, and removes only drawn links', async () => {
    const r = await rig();
    const { name } = await r.context.remember({ text: 'A note.', scope: 'everyone' }, who);
    const target = { kind: 'context', name: QualifiedName.parse('fs/guide') } as const;
    const link = await r.context.link({ from: name, to: target, relation: 'related', weight: 0.5 }, who);
    expect(link).toMatchObject({ source: 'authored', toKey: 'context:fs/guide' });
    const view = await r.context.item(name, who);
    expect(view.links).toHaveLength(1);
    expect(view.text).toBe('A note.');
    expect(await r.context.unlink({ from: name, toKey: 'context:fs/guide', relation: 'related' }, who)).toBe(true);
    expect(await r.context.unlink({ from: name, toKey: 'context:fs/guide', relation: 'related' }, who)).toBe(false);
    await r.graph.replaceResourceLinks(name, [{ to: target, relation: 'about', weight: 1 }]);
    await expect(r.context.unlink({ from: name, toKey: 'context:fs/guide', relation: 'about' }, who)).rejects.toMatchObject({ status: 403 });
  });
});
