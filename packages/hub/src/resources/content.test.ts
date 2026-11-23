import { ResourceUri, SectionKey } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { FormMessageContent } from './content.ts';
import type { ContentModel } from './index.ts';
import { ALICE, bytes, resourcesRig, statOf } from './testing.ts';

const who = { actor: ALICE };
/** A PNG's signature and IHDR chunk: 640 by 480. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x80, 0, 0, 1, 0xe0]);
const model = (capabilities: string[]): ContentModel => ({ id: 'm', capabilities });

async function rig(options: { answers?: boolean } = {}) {
  const r = await resourcesRig();
  const content = new FormMessageContent({ forms: r.forms, reader: r.reader, content: r.content, log: r.log, answersImages: () => Promise.resolve(options.answers ?? true) });
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

  it('sends a model that can\'t see an <image> block with its id, facts and how to ask about it, and makes no model call', async () => {
    const r = await rig();
    const [part, ...rest] = await r.content.parts(r.image, model(['chat']), who, { source: 'attached to a message' });
    expect(rest).toHaveLength(0);
    expect(part).toMatchObject({ type: 'text', name: 'cat.png' });
    const block = part?.content ?? '';
    expect(block).toMatch(/^<image id="file:\/\/main\/cat\.png" name="cat\.png" mime="image\/png" size="24" width="640" height="480" source="attached to a message">/);
    expect(block).toContain('hub/image_read with {"image": "file://main/cat.png", "question": ');
    expect(block).not.toContain('data:');
    expect(r.models.calls).toHaveLength(0);
  });

  it('says so in the block when no image model is set up to answer about it', async () => {
    const r = await rig({ answers: false });
    const [part] = await r.content.parts(r.image, model(['chat']), who);
    expect(part?.content).toContain('No model that can see images is set up');
    expect(part?.content).not.toContain('hub/image_read');
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
    const talk = ResourceUri.parse('file://main/talk.wav');
    r.raw.serve({ stat: statOf(talk, { format: 'audio', mime: 'audio/wav' }), bytes: bytes('RIFF....WAVE') });
    r.models.off.add('transcript');
    const parts = await r.content.parts(talk, model(['chat']), who);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text', name: 'talk.wav' });
    expect(parts[0]?.content).toContain('could not be shown');
    const missing = await r.content.parts(ResourceUri.parse('file://main/gone.txt'), model(['chat']), who);
    expect(missing[0]?.content).toContain('file://main/gone.txt');
  });
});
