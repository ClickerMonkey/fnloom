/**
 * Attached files (iteration 2): a sent message's files are kept as hub resources, each part carrying its uri (a
 * sender's own is never kept) and a small text file's text, their readers join the session's tools, and a file that
 * can't be kept still goes out with its content ref.
 */
import { ResourceUri, SessionId, type ContentRef } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { createChat } from './chat.ts';
import type { AttachedFiles } from './deps.ts';
import { fileReaders, isTextFile, resourceFiles } from './files.ts';
import { ALICE, bytes, resourcesRig } from '../resources/testing.ts';
import { chatRig, CLIENT } from './testing.ts';

const pdf: ContentRef = { hash: 'b'.repeat(64), size: 900, mime: 'application/pdf' };
const photo: ContentRef = { hash: 'c'.repeat(64), size: 800, mime: 'image/jpeg' };
const notes: ContentRef = { hash: 'd'.repeat(64), size: 9, mime: 'text/plain' };

async function world(files: AttachedFiles) {
  const rig = await chatRig();
  await rig.init();
  for (const name of ['resource_read', 'resource_send', 'resource_outline']) rig.catalog.addFn('hub', { name, tags: ['read'] });
  const chat = createChat({ ...rig.deps, files });
  const session = await chat.sessions.create({ owner: rig.admin.id });
  return { ...rig, chat, session };
}

describe('attached files', () => {
  it('are kept as resources the model reads by uri, a small text file in the message, and their readers are loaded', async () => {
    const kept: Array<{ name: string; maxChars: number }> = [];
    const w = await world({
      keep: (file, _who, maxChars) => {
        kept.push({ name: file.name, maxChars });
        const uri = ResourceUri.parse(`hub://resources/uploads/2026-11-22/${file.name}`);
        return Promise.resolve(file.ref.mime === 'text/plain' ? { uri, text: 'milk, eggs', truncated: false } : { uri });
      },
    });
    const { message } = await w.chat.turns.send({
      session: w.session.id, author: w.admin.id, client: CLIENT, parts: [
        { type: 'text', text: 'Compare these.' },
        // a sender's own uri and text are never kept
        { type: 'file', ref: pdf, name: 'quote.pdf', uri: 'hub://resources/elsewhere/secret.pdf', text: 'made up' },
        { type: 'file', ref: photo, name: 'receipt.jpg' },
        { type: 'file', ref: notes, name: 'list.txt' },
      ],
    });
    expect(kept).toEqual([{ name: 'quote.pdf', maxChars: 4_000 }, { name: 'receipt.jpg', maxChars: 4_000 }, { name: 'list.txt', maxChars: 4_000 }]);
    expect(message.parts.filter((part) => part.type === 'file')).toEqual([
      { type: 'file', ref: pdf, name: 'quote.pdf', uri: 'hub://resources/uploads/2026-11-22/quote.pdf' },
      { type: 'file', ref: photo, name: 'receipt.jpg', uri: 'hub://resources/uploads/2026-11-22/receipt.jpg' },
      { type: 'file', ref: notes, name: 'list.txt', uri: 'hub://resources/uploads/2026-11-22/list.txt', text: 'milk, eggs' },
    ]);
    expect(w.chat.enrich.render(message)).toContain('uri="hub://resources/uploads/2026-11-22/receipt.jpg" read="hub/resource_send" />');
    expect((await w.store.table('sessions').get(w.session.id))?.tools).toEqual(expect.arrayContaining(['hub/resource_read', 'hub/resource_send', 'hub/resource_outline']));
  });

  it('go out with their content ref when they can\'t be kept', async () => {
    const w = await world({ keep: () => Promise.reject(new Error('disk full')) });
    const { message } = await w.chat.turns.send({ session: w.session.id, author: w.admin.id, client: CLIENT, parts: [{ type: 'file', ref: pdf, name: 'quote.pdf' }] });
    expect(message.parts).toContainEqual({ type: 'file', ref: pdf, name: 'quote.pdf' });
    expect(w.chat.enrich.render(message)).toContain(`hash="${pdf.hash}"`);
    expect(w.logs.some((record) => record.msg === 'chat.file.keep-failed')).toBe(true);
  });

  it('read text formats in the message and pick the reader by type', () => {
    expect([isTextFile('text/csv', 'a.csv'), isTextFile('application/json', 'a'), isTextFile('application/octet-stream', 'n.md'), isTextFile('application/pdf', 'a.pdf')]).toEqual([true, true, true, false]);
    expect(fileReaders([{ type: 'file', ref: pdf, name: 'a.pdf', uri: 'hub://resources/a.pdf' }])).toEqual(['hub/resource_read', 'hub/resource_outline']);
    expect(fileReaders([{ type: 'file', ref: pdf, name: 'a.pdf' }])).toEqual([]);
  });
});

describe('resourceFiles over the real resources module', () => {
  it('keeps an upload as a hub resource and reads a text file back, cut at maxChars', async () => {
    const r = await resourcesRig();
    const files = resourceFiles(() => r);
    const who = { actor: ALICE, session: SessionId.parse('ses_1') };
    const text = await r.content.put(bytes('milk\neggs\nbread\n'), 'text/plain');
    expect(await files.keep({ ref: text, name: 'list.txt' }, who, 9)).toEqual({ uri: 'hub://resources/uploads/2026-11-07/list.txt', text: 'milk\neggs', truncated: true });
    expect(await files.keep({ ref: text, name: 'list.txt' }, who, 0)).toEqual({ uri: 'hub://resources/uploads/2026-11-07/list.txt' });
    const image = await r.content.put(bytes('not really a jpeg'), 'image/jpeg');
    expect(await files.keep({ ref: image, name: 'receipt.jpg' }, who, 4_000)).toEqual({ uri: 'hub://resources/uploads/2026-11-07/receipt.jpg' });
  });
});
