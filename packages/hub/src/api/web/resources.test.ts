/**
 * The resources and context slices: each endpoint reaches the resources module's operation as the signed-in person
 * and answers what it answers.
 */
import { QualifiedName, ResourceUri, SystemName, type ResourceRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

const uri = ResourceUri.parse('hub://resources/uploads/2026-11-07/a.md');
const record: ResourceRecord = { uri, system: SystemName.parse('hub'), stat: { uri, name: 'a.md', type: 'file', version: 'v1' }, links: [], seenAt: 1 };

async function signedIn(fakes: Fakes) {
  const web = await webRig(await rig(fakes));
  const tokens = await web.admin();
  return { web, as: web.as(tokens), me: tokens.user.id };
}

describe('resources endpoints', () => {
  it('browse, read, convert, import, rename, delete and make context as the person', async () => {
    const calls: unknown[][] = [];
    const push = (...call: unknown[]) => { calls.push(call); };
    const { web, as, me } = await signedIn({
      resources: {
        library: {
          browse: (query, who) => { push('browse', query, who); return Promise.resolve({ items: [record], facets: [{ value: 'document', label: 'Documents', count: 1 }] }); },
          import: (args, who) => { push('import', args, who); return Promise.resolve(record); },
          rename: (at, name, who) => { push('rename', at, name, who); return Promise.resolve(record); },
          remove: (at, who) => { push('remove', at, who); return Promise.resolve({ deleted: true, referencedBy: 0 }); },
        },
        reader: {
          read: (args, who) => { push('read', args, who); return Promise.resolve({ uri, form: 'raw', text: '# A', offset: 0, total: 3, truncated: false, forms: [], offers: [] }); },
          download: (at, form, who) => { push('download', at, form, who); return Promise.resolve({ url: 'https://files/x', mime: 'text/markdown', size: 3 }); },
        },
        forms: {
          forms: (at, who) => { push('forms', at, who); return Promise.resolve({ record, forms: [], offers: [] }); },
          ensure: (at, kind, who) => {
            push('ensure', at, kind, who);
            return Promise.resolve({ hash: 'a'.repeat(64), kind, converter: 'model:x', content: { hash: 'b'.repeat(64), size: 1, mime: 'text/plain' }, chars: 1, tokens: 1, createdAt: 1 });
          },
        },
        context: { fromResource: (args, who) => { push('fromResource', args, who); return Promise.resolve({ created: [], updated: [], links: 0 }); } },
      },
    });
    const who = { actor: me };
    await expect(web.client.call('browseResources', { group: 'type' }, as)).resolves.toMatchObject({ facets: [{ value: 'document' }] });
    await web.client.call('resourceForms', { uri }, as);
    await expect(web.client.call('readResource', { uri, maxChars: 10 }, as)).resolves.toMatchObject({ text: '# A' });
    await web.client.call('convertResource', { uri, kind: 'description' }, as);
    await web.client.call('downloadResource', { uri }, as);
    await web.client.call('importResource', { url: 'https://site.dev/' }, as);
    await web.client.call('renameResource', { uri, name: 'b.md' }, as);
    await expect(web.client.call('deleteResource', { uri }, as)).resolves.toEqual({ deleted: true, referencedBy: 0 });
    await web.client.call('contextFromResource', { uri }, as);
    expect(calls).toEqual([
      ['browse', { group: 'type' }, who], ['forms', uri, who], ['read', { uri, maxChars: 10 }, who], ['ensure', uri, 'description', who],
      ['download', uri, undefined, who], ['import', { url: 'https://site.dev/' }, who], ['rename', uri, 'b.md', who], ['remove', uri, who],
      ['fromResource', { uri, copy: 'live' }, { ...who, admin: true }],
    ]);
  });
});

describe('context endpoints', () => {
  it('list, show, remember, forget, link and unlink as the person', async () => {
    const calls: unknown[][] = [];
    const push = (...call: unknown[]) => { calls.push(call); };
    const name = QualifiedName.parse('memory/note-12345678');
    const link = { from: name, to: { kind: 'context', name: QualifiedName.parse('fs/guide') }, toKey: 'context:fs/guide', relation: 'related', weight: 0.5, source: 'authored', updatedAt: 1 } as const;
    const { web, as, me } = await signedIn({
      resources: {
        context: {
          list: (query, who) => { push('list', query, who); return Promise.resolve({ items: [] }); },
          item: (at, who) => { push('item', at, who); return Promise.reject(new Error('not used')); },
          remember: (args, who) => { push('remember', args, who); return Promise.resolve({ name }); },
          forget: (at, who) => { push('forget', at, who); return Promise.resolve(true); },
          link: (input, who) => { push('link', input, who); return Promise.resolve(link); },
          unlink: (key, who) => { push('unlink', key, who); return Promise.resolve(false); },
        },
      },
    });
    const who = { actor: me };
    await web.client.call('contexts', {}, as);
    await expect(web.client.call('remember', { text: 'A note.', scope: 'user' }, as)).resolves.toEqual({ name });
    await web.client.call('remember', { text: 'No scope.' }, as);
    await expect(web.client.call('forget', { name }, as)).resolves.toEqual({ ok: true });
    await expect(web.client.call('linkContext', { from: name, to: link.to, relation: 'related', weight: 0.5 }, as)).resolves.toMatchObject({ source: 'authored' });
    await expect(web.client.call('unlinkContext', { from: name, toKey: link.toKey, relation: 'related' }, as)).resolves.toEqual({ ok: false });
    expect(calls).toEqual([
      ['list', {}, who], ['remember', { text: 'A note.', scope: 'user' }, { ...who, admin: true }], ['remember', { text: 'No scope.', scope: 'user' }, { ...who, admin: true }], ['forget', name, who],
      ['link', { from: name, to: link.to, relation: 'related', weight: 0.5 }, who], ['unlink', { from: name, toKey: link.toKey, relation: 'related' }, who],
    ]);
  });
});
