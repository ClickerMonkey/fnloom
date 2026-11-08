import { ResourceUri, SectionKey } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { FormMessageContent } from './content.ts';
import type { ContentModel } from './index.ts';
import { ALICE, bytes, resourcesRig, statOf } from './testing.ts';

const who = { actor: ALICE };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const model = (capabilities: string[]): ContentModel => ({ id: 'm', capabilities });

async function rig() {
  const r = await resourcesRig();
  const content = new FormMessageContent({ forms: r.forms, reader: r.reader, content: r.content, log: r.log });
  const image = ResourceUri.parse('file://main/cat.png');
  const pdf = ResourceUri.parse('file://main/r.pdf');
  const scanned = ResourceUri.parse('file://main/s.pdf');
  const page = ResourceUri.parse('file://main/p.html');
  r.raw.serve({ stat: statOf(image, { format: 'image', mime: 'image/png' }), bytes: PNG });
  r.raw.serve({ stat: statOf(pdf, { format: 'pdf', mime: 'application/pdf' }), text: 'Page one text' });
  r.raw.serve({ stat: statOf(scanned, { format: 'pdf', mime: 'application/pdf' }), bytes: bytes('%PDF-1.4 not really') });
  r.raw.serve({ stat: statOf(page, { format: 'html', mime: 'text/html' }), bytes: bytes('<main><h1>Hi</h1><p>there</p></main>') });
  return { ...r, content: content, image, pdf, scanned, page };
}

describe('resources as message content', () => {
  it('sends an image as an image to a model that sees', async () => {
    const r = await rig();
    const [part] = await r.content.parts(r.image, model(['chat', 'vision']), who);
    expect(part).toMatchObject({ type: 'image', format: 'image/png', name: 'cat.png' });
    expect(part?.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(r.models.calls).toHaveLength(0);
  });

  it('sends a text-only model the image\'s description, made once', async () => {
    const r = await rig();
    const first = await r.content.parts(r.image, model(['chat']), who);
    const second = await r.content.parts(r.image, model(['chat']), who);
    expect(first).toEqual(second);
    expect(first[0]?.type).toBe('text');
    expect(first[0]?.content).toContain('description of cat.png');
    expect(r.models.calls).toHaveLength(1);
  });

  it('sends a pdf as a file to a model that takes files, else its text', async () => {
    const r = await rig();
    expect((await r.content.parts(r.scanned, model(['chat', 'files']), who))[0]?.type).toBe('file');
    expect((await r.content.parts(r.pdf, model(['chat', 'files']), who))[0]?.type).toBe('text');
    const [text] = await r.content.parts(r.pdf, model(['chat']), who);
    expect(text?.content).toContain('Page one text');
  });

  it('sends a page as its markdown', async () => {
    const r = await rig();
    const [part] = await r.content.parts(r.page, model(['chat', 'vision']), who);
    expect(part?.type).toBe('text');
    expect(part?.content).toContain('# Hi');
    expect(part?.content).toContain('markdown');
  });

  it('sends one section as its text in the primary form, whatever the model takes', async () => {
    const r = await rig();
    const doc = ResourceUri.parse('file://main/notes.md');
    r.raw.serve({ stat: statOf(doc, { format: 'markdown', mime: 'text/markdown' }), bytes: bytes('# One\nfirst\n\n# Two\nsecond\n') });
    const [part, ...rest] = await r.content.parts(doc, model(['chat', 'vision', 'files']), who, { section: SectionKey.parse('Two') });
    expect(rest).toHaveLength(0);
    expect(part?.type).toBe('text');
    expect(part?.content).toContain('second');
    expect(part?.content).not.toContain('first');
  });

  it('never fails: what can\'t be made becomes one short text part', async () => {
    const r = await rig();
    r.models.off.add('description');
    const parts = await r.content.parts(r.image, model(['chat']), who);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text', name: 'cat.png' });
    expect(parts[0]?.content).toContain('could not be shown');
    const missing = await r.content.parts(ResourceUri.parse('file://main/gone.txt'), model(['chat']), who);
    expect(missing[0]?.content).toContain('file://main/gone.txt');
  });
});
