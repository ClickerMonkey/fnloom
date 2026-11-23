/**
 * Resources shown in a conversation (`shown.ts`): kept as references, made for each call's model. A model that sees
 * gets the picture; one that can't gets an `<image>` block whose id `hub/image_read` takes, for a shown image, an
 * attached one and an image part alike. The kept conversation never changes, so a model switch or an undo reads the
 * same.
 */
import { ResourceUri, type LlmMessage, type ModelInfo } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { exchanges, isPersonMessage } from '../contextor/history.ts';
import { AUTO_MODEL } from '../contextor/limits.ts';
import { FormMessageContent } from '../resources/content.ts';
import { ALICE, bytes, resourcesRig, statOf } from '../resources/testing.ts';
import { fileTag } from './files.ts';
import { ConversationMedia, parseShown, shownMessage } from './shown.ts';

/** A PNG's signature and IHDR chunk: 32 by 16. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 32, 0, 0, 0, 16]);
const who = { actor: ALICE };

const MODELS: ReadonlyArray<Pick<ModelInfo, 'id' | 'provider' | 'capabilities'>> = [
  { id: 'sees', provider: 'openrouter', capabilities: ['chat', 'vision'] },
  { id: 'blind', provider: 'openrouter', capabilities: ['chat', 'tools'] },
];

async function world() {
  const r = await resourcesRig();
  const content = new FormMessageContent({ forms: r.forms, reader: r.reader, content: r.content, log: r.log, answersImages: () => Promise.resolve(true) });
  const media = new ConversationMedia({ content: () => content, models: () => Promise.resolve(MODELS), maxChars: 40 });
  const image = ResourceUri.parse('file://main/chart.png');
  const doc = ResourceUri.parse('file://main/notes.md');
  r.raw.serve({ stat: statOf(image, { format: 'image', mime: 'image/png' }), bytes: PNG });
  r.raw.serve({ stat: statOf(doc, { format: 'markdown', mime: 'text/markdown' }), bytes: bytes(`# Notes\n${'word '.repeat(40)}\n`) });
  return { ...r, media, image, doc };
}

/** A person's message with an attached picture and an attached document, as the enricher writes it. */
function attached(image: ResourceUri): LlmMessage {
  const picture = fileTag({ type: 'file', name: 'chart.png', ref: { hash: 'a'.repeat(64), size: PNG.length, mime: 'image/png' }, uri: image });
  const pdf = fileTag({ type: 'file', name: 'r.pdf', ref: { hash: 'b'.repeat(64), size: 9, mime: 'application/pdf' }, uri: 'hub://resources/uploads/2026-11-23/r.pdf' });
  return { role: 'user', content: `What does this show?\n${picture}\n${pdf}` };
}

/** A conversation where the model asked to see the picture. */
function conversation(image: ResourceUri): LlmMessage[] {
  return [
    attached(image),
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'hub__resource_send', arguments: JSON.stringify({ uri: image }) }] },
    { role: 'tool', toolCallId: 'c1', content: '{"parts":[{"type":"image","chars":100}]}' },
    shownMessage(image),
  ];
}

describe('a shown resource', () => {
  it('is kept as a reference the hub wrote, which starts no exchange', () => {
    const message = shownMessage('file://main/a "b".png', 'Page 2');
    expect(parseShown(typeof message.content === 'string' ? message.content : '')).toEqual({ uri: 'file://main/a "b".png', section: 'Page 2' });
    expect(isPersonMessage(message)).toBe(false);
    expect(exchanges(conversation(ResourceUri.parse("file://main/chart.png")))).toHaveLength(1);
  });

  it('is the picture itself for a model that sees, and the attached tags stay as they are', async () => {
    const w = await world();
    const kept = conversation(w.image);
    const sent = await w.media.expand(kept, 'sees', who);
    expect(sent[0]).toEqual(kept[0]);
    const shown = sent[3]?.content;
    expect(Array.isArray(shown) ? shown.map((part) => part.type) : shown).toEqual(['text', 'image']);
    expect(Array.isArray(shown) ? shown[1]?.content.startsWith('data:image/png;base64,') : false).toBe(true);
    expect(isPersonMessage(sent[3] ?? { role: 'user', content: '' })).toBe(false);
  });

  it('is an <image> block with an id the image-read fn takes for a model that can\'t see, attached pictures too', async () => {
    const w = await world();
    const sent = await w.media.expand(conversation(w.image), 'blind', who);
    const person = typeof sent[0]?.content === 'string' ? sent[0].content : '';
    expect(person).toContain('What does this show?');
    expect(person).toContain(`<image id="${w.image}" name="chart.png" mime="image/png" size="${PNG.length}" width="32" height="16" source="attached to a message">`);
    expect(person).not.toContain('<file name="chart.png"');
    // a document's tag is not an image's, so it stays
    expect(person).toContain('<file name="r.pdf"');
    const shown = sent[3]?.content;
    expect(Array.isArray(shown) ? shown.map((part) => part.type) : shown).toEqual(['text', 'text']);
    expect(Array.isArray(shown) ? shown[1]?.content : '').toContain(`<image id="${w.image}" name="chart.png"`);
    expect(Array.isArray(shown) ? shown[1]?.content : '').toContain('source="shown by hub/resource_send"');
    expect(JSON.stringify(sent)).not.toContain('data:image');
    expect(w.models.calls).toHaveLength(0);
  });

  it('takes an automatic or unknown model as one that can\'t see', async () => {
    const w = await world();
    for (const model of [AUTO_MODEL, 'nobody-offers-this']) {
      const sent = await w.media.expand(conversation(w.image), model, who);
      expect(JSON.stringify(sent), model).not.toContain('data:image');
      expect(JSON.stringify(sent), model).toContain('<image id=');
    }
  });

  it('turns an image part already in a message into a block for a model that can\'t see, and leaves it for one that sees', async () => {
    const w = await world();
    const kept: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', content: 'look' }, { type: 'image', content: 'data:image/png;base64,AAAA', format: 'image/png', name: 'x.png' }] }];
    expect(await w.media.expand(kept, 'sees', who)).toEqual(kept);
    const [blind] = await w.media.expand(kept, 'blind', who);
    const parts = Array.isArray(blind?.content) ? blind.content : [];
    expect(parts.map((part) => part.type)).toEqual(['text', 'text']);
    expect(parts[1]?.content).toContain('<image name="x.png" mime="image/png"');
  });

  it('keeps a shown document\'s text to the limit, saying how to read on', async () => {
    const w = await world();
    const [sent] = await w.media.expand([shownMessage(w.doc)], 'sees', who);
    const text = Array.isArray(sent?.content) ? sent.content[1]?.content ?? '' : '';
    expect(text).toContain('[cut after 40 of');
    expect(text).toContain('hub/resource_read');
  });

  it('never changes the kept conversation: a model switch reads it the new model\'s way, and cutting a turn cuts its references', async () => {
    const w = await world();
    const kept = conversation(w.image);
    const before = JSON.stringify(kept);
    const blind = await w.media.expand(kept, 'blind', who);
    const sees = await w.media.expand(kept, 'sees', who);
    expect(JSON.stringify(kept)).toBe(before);
    expect(JSON.stringify(blind)).toContain('<image id=');
    expect(JSON.stringify(sees)).toContain('data:image/png');
    // an undo cuts the transcript back to before the turn: nothing of it, references included, is sent again
    const undone = await w.media.expand([...kept.slice(0, 0), { role: 'user', content: 'Something else.' }], 'blind', who);
    expect(JSON.stringify(undone)).not.toContain(w.image);
  });
});
