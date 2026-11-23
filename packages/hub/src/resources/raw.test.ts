/** Reading a system resource's raw bytes over the link: refused when nothing serves it, from the content store when uploaded, else in chunks. */
import { ContentRef, ResourceUri, SystemName, type ResourceRead } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { LinkRawReader, type RawSource } from './raw.ts';

const URI = ResourceUri.parse('file:///docs/a.pdf');
const FS = SystemName.parse('fs');
const BYTES = new TextEncoder().encode('0123456789abcdefghij');
const REF = ContentRef.parse({ hash: 'b'.repeat(64), size: BYTES.length, mime: 'application/pdf' });
const STAT = { uri: URI, name: 'a.pdf', type: 'file' as const, mime: 'application/pdf', version: '1' };

/** A fake instance that answers a read and serves chunks of its bytes, recording what it was asked. */
function source(read: ResourceRead, served: Uint8Array = BYTES) {
  const chunks: Array<{ offset: number; length: number }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const fake: RawSource = {
    system: FS,
    read: (_ask, signal) => { signals.push(signal); return Promise.resolve(read); },
    content: ({ offset, length }, signal) => {
      chunks.push({ offset, length });
      signals.push(signal);
      return Promise.resolve({ chunk: Buffer.from(served.subarray(offset, offset + length)).toString('base64') });
    },
  };
  return { fake, chunks, signals };
}

/** A reader over a source and a content store holding what `stored` lists. */
function reader(from: RawSource | undefined, stored: readonly ContentRef[] = []) {
  const reads: string[] = [];
  const raw = new LinkRawReader({
    source: () => from, stat: () => Promise.resolve(STAT), maxChunk: 8,
    content: {
      has: (ref) => Promise.resolve(stored.some((s) => s.hash === ref.hash)),
      read: (ref) => { reads.push(ref.hash); return Promise.resolve(BYTES); },
    },
  });
  return { raw, reads };
}

describe('reading raw bytes over the link', () => {
  it('refuses a URI no connected system serves', async () => {
    await expect(reader(undefined).raw.read(URI)).rejects.toMatchObject({ status: 404, code: 'NO_RESOURCE' });
  });

  it('reads bytes the system uploaded from the content store, asking it for nothing more', async () => {
    const s = source({ stat: STAT, bytes: REF, text: { inline: 'A pdf.' } });
    const { raw, reads } = reader(s.fake, [REF]);
    expect(await raw.read(URI)).toEqual({ system: FS, stat: STAT, links: [], bytes: BYTES, text: 'A pdf.' });
    expect(reads).toEqual([REF.hash]);
    expect(s.chunks).toEqual([]);
  });

  it('fetches bytes it holds in chunks of the largest chunk, at the right offsets, passing the signal on', async () => {
    const s = source({ stat: STAT, bytes: REF, links: [{ uri: ResourceUri.parse('file:///docs/b.pdf'), raw: './b.pdf', kind: 'link' }] });
    const signal = new AbortController().signal;
    const read = await reader(s.fake).raw.read(URI, signal);
    expect(Buffer.from(read.bytes ?? new Uint8Array()).toString()).toBe('0123456789abcdefghij');
    expect(read.links).toHaveLength(1);
    expect(s.chunks).toEqual([{ offset: 0, length: 8 }, { offset: 8, length: 8 }, { offset: 16, length: 4 }]);
    expect(s.signals.every((given) => given === signal)).toBe(true);
  });

  it('reads long text by ref the same way', async () => {
    const s = source({ stat: STAT, text: { ref: REF } });
    expect((await reader(s.fake).raw.read(URI)).text).toBe('0123456789abcdefghij');
  });

  it('fetches the bytes and the text by ref together, each in order', async () => {
    const s = source({ stat: STAT, bytes: REF, text: { ref: REF } });
    const read = await reader(s.fake).raw.read(URI);
    expect(Buffer.from(read.bytes ?? new Uint8Array()).toString()).toBe('0123456789abcdefghij');
    expect(read.text).toBe('0123456789abcdefghij');
    // the two fetches' chunks interleave, so neither waited for the other
    expect(s.chunks.map((chunk) => chunk.offset)).toEqual([0, 0, 8, 8, 16, 16]);
  });

  it('refuses bytes the system stopped sending short of their size', async () => {
    const s = source({ stat: STAT, bytes: REF }, BYTES.subarray(0, 10));
    await expect(reader(s.fake).raw.read(URI)).rejects.toMatchObject({ status: 502, code: 'CONTENT_SHORT' });
  });

  it('asks the serving system for a stat', async () => {
    await expect(reader(undefined).raw.stat(URI)).resolves.toEqual(STAT);
  });
});
