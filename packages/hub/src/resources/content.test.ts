import { ResourceUri, SectionKey } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { FormMessageContent } from './content.ts';
import type { ContentModel } from './index.ts';
import { ALICE, bytes, madePdf, resourcesRig, statOf } from './testing.ts';

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

  it('tells an image by its bytes, whatever its name or the system said, and never sends what isn\'t one as a picture', async () => {
    const r = await rig();
    const shouting = ResourceUri.parse('file://main/IMG_2890.JPG');
    r.raw.serve({ stat: statOf(shouting, { format: 'image', mime: 'text/plain' }), bytes: PNG });
    const [real] = await r.content.parts(shouting, model(['chat', 'vision']), who);
    expect(real).toMatchObject({ type: 'image', format: 'image/png' });
    // a picture a system sent as its own (empty) text: a provider refuses such a part, and every turn after it
    const empty = ResourceUri.parse('file://main/IMG_3000.JPG');
    r.raw.serve({ stat: statOf(empty, { format: 'image', mime: 'image/jpeg' }), text: '' });
    const [note, ...rest] = await r.content.parts(empty, model(['chat', 'vision']), who);
    expect(rest).toHaveLength(0);
    expect(note?.type).toBe('text');
    expect(note?.content).toContain("IMG_3000.JPG (file://main/IMG_3000.JPG) can't be shown to you as a picture: it is empty");
    expect(note?.content).toContain('hub/resource_read');
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

  it('sends a pdf with no text (a scan) as its pages\' pictures to a model that sees, a page or the first few', async () => {
    const r = await rig();
    const uri = ResourceUri.parse('file://main/scan.pdf');
    const page = { kind: 'bitmap', width: 2, height: 2, channels: 1, samples: new Uint8Array([0, 255, 255, 0]) } as const;
    r.raw.serve({ stat: statOf(uri, { format: 'pdf', mime: 'application/pdf' }), bytes: madePdf([page, { kind: 'text', text: '' }, page]) });
    const sees = model(['chat', 'vision']);
    const whole = await r.content.parts(uri, sees, who);
    expect(whole.map((part) => part.type)).toEqual(['text', 'image', 'image', 'text']);
    expect(whole[0]?.content).toContain('scan.pdf (file://main/scan.pdf) has no text in it: its pages are pictures');
    expect(whole[1]).toMatchObject({ format: 'image/png', name: 'scan.pdf, page 1' });
    expect(whole[1]?.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(whole[2]).toMatchObject({ name: 'scan.pdf, page 3' });
    // the page with neither text nor a picture says so, never pretends it was shown
    expect(whole[3]?.content).toBe("Page 2 of scan.pdf has no picture that can be shown here, so what it says can't be read: tell the person, and don't guess.");
    const one = await r.content.parts(uri, sees, who, { section: SectionKey.parse('Page 3') });
    expect(one.map((part) => part.type)).toEqual(['text', 'image']);
    expect(one[0]?.content).toContain('Page 3 of scan.pdf (file://main/scan.pdf) has no text: it is a picture of the page');
    expect(one[0]?.content).toContain('Here is the picture of page 3');
    expect(one[0]?.content).toContain('This is page 3 of its 3: see another with hub/resource_send');
    // a model that can't see is told how to ask about a page
    const [blind, ...rest] = await r.content.parts(uri, model(['chat']), who, { section: SectionKey.parse('Page 1') });
    expect(rest).toHaveLength(0);
    expect(blind?.content).toContain('call hub/image_read with {"image": "file://main/scan.pdf", "page": 1, "question": ');
  });

  it('sends a pdf with text as its text, a page of it as that page\'s text', async () => {
    const r = await rig();
    const uri = ResourceUri.parse('file://main/rules.pdf');
    r.raw.serve({ stat: statOf(uri, { format: 'pdf', mime: 'application/pdf' }), bytes: madePdf([{ kind: 'text', text: 'Rule one' }, { kind: 'text', text: 'Rule two' }]) });
    const [whole] = await r.content.parts(uri, model(['chat', 'vision']), who);
    expect(whole?.content).toContain('Rule one');
    expect(whole?.content).toContain('Rule two');
    const [page] = await r.content.parts(uri, model(['chat', 'vision']), who, { section: SectionKey.parse('Page 2') });
    expect(page?.content).toContain('Rule two');
    expect(page?.content).not.toContain('Rule one');
    const read = await r.reader.read({ uri }, who);
    expect(read.note).toBeUndefined();
  });

  it('says on a read of a pdf with no text that its pages are pictures, and how to look at them', async () => {
    const r = await rig();
    const uri = ResourceUri.parse('file://main/scan.pdf');
    r.raw.serve({ stat: statOf(uri, { format: 'pdf', mime: 'application/pdf' }), bytes: madePdf([{ kind: 'bitmap', width: 1, height: 1, channels: 1, samples: new Uint8Array([9]) }]) });
    const read = await r.reader.read({ uri }, who);
    expect(read.form).toBe('pages');
    expect(read.note).toContain('This pdf has no text in it: its page is a picture');
    expect(read.note).toContain('hub/resource_send');
    expect(read.note).toContain('hub/image_read');
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
