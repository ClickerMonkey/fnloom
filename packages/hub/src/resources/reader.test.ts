import { ResourceUri, SectionKey } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ALICE, bytes, resourcesRig, statOf } from './testing.ts';

const who = { actor: ALICE };
const PAGE = '<html><body><main><h1>Guide</h1><p>Hello there.</p><h2>Usage</h2><p>Run it.</p></main></body></html>';
const CSV = `name,qty\n${Array.from({ length: 8 }, (_, i) => `row${i + 1},${i + 1}`).join('\n')}\n`;

async function rig() {
  const r = await resourcesRig({ maxRows: 5 });
  const page = ResourceUri.parse('file://main/guide.html');
  const sheet = ResourceUri.parse('file://main/stock.csv');
  const bin = ResourceUri.parse('file://main/blob.bin');
  r.raw.serve({ stat: statOf(page, { format: 'html', mime: 'text/html' }), bytes: bytes(PAGE) });
  r.raw.serve({ stat: statOf(sheet, { format: 'csv', mime: 'text/csv' }), bytes: bytes(CSV) });
  r.raw.serve({ stat: statOf(bin, { mime: 'application/octet-stream' }), bytes: new Uint8Array([0, 1, 2, 3]) });
  return { ...r, page, sheet, bin };
}

describe('reading resources', () => {
  it('reads the primary form by default, with the forms there are', async () => {
    const r = await rig();
    const read = await r.reader.read({ uri: r.page }, who);
    expect(read).toMatchObject({ form: 'markdown', offset: 0, truncated: false, forms: ['markdown'], offers: [] });
    expect(read.text).toContain('## Usage');
    expect(read.total).toBe(read.text.length);
  });

  it('reads the raw text, a window of it, and one section', async () => {
    const r = await rig();
    const raw = await r.reader.read({ uri: r.page, form: 'raw' }, who);
    expect(raw.text).toBe(PAGE);
    const window = await r.reader.read({ uri: r.page, form: 'raw', offset: 6, maxChars: 6 }, who);
    expect(window).toMatchObject({ text: PAGE.slice(6, 12), offset: 6, total: PAGE.length, truncated: true });
    const usage = await r.reader.read({ uri: r.page, section: SectionKey.parse('Guide > Usage') }, who);
    expect(usage.text.startsWith('## Usage')).toBe(true);
    expect(usage.text).not.toContain('Hello');
    await expect(r.reader.read({ uri: r.page, section: SectionKey.parse('Nope') }, who)).rejects.toMatchObject({ status: 404 });
  });

  it('reads rows of a table, saying how many there really are', async () => {
    const r = await rig();
    const rows = await r.reader.read({ uri: r.sheet, rows: { table: '1', from: 1, to: 3 } }, who);
    expect(rows.form).toBe('table');
    expect(rows.text).toContain('row2');
    expect(rows.text).toContain('row3');
    expect(rows.text).not.toContain('row4');
    expect(rows).toMatchObject({ offset: 1, total: 8, truncated: true });
    await expect(r.reader.read({ uri: r.sheet, rows: { table: 'missing', from: 0, to: 1 } }, who)).rejects.toMatchObject({ status: 404 });
    await expect(r.reader.read({ uri: r.page, rows: { table: '1', from: 0, to: 1 } }, who)).rejects.toMatchObject({ status: 422 });
  });

  it('refuses rows past the ones it keeps instead of answering empty, and ends a range at what is kept', async () => {
    const r = await rig();
    // the rig keeps 5 of the sheet's 8 rows
    await expect(r.reader.read({ uri: r.sheet, rows: { table: '1', from: 6, to: 8 } }, who)).rejects.toMatchObject({ status: 422, code: 'ROWS_NOT_KEPT' });
    const edge = await r.reader.read({ uri: r.sheet, rows: { table: '1', from: 3, to: 8 } }, who);
    expect(edge.text).toContain('row5');
    expect(edge.text).not.toContain('row6');
    expect(edge).toMatchObject({ offset: 3, total: 8, truncated: true });
    // past the real end is an empty, whole read
    expect(await r.reader.read({ uri: r.sheet, rows: { table: '1', from: 9, to: 12 } }, who)).toMatchObject({ total: 8, truncated: false });
  });

  it('refuses the raw text of binary content, naming what can be read instead', async () => {
    const r = await rig();
    await expect(r.reader.read({ uri: r.bin }, who)).rejects.toMatchObject({ status: 422 });
    await expect(r.reader.read({ uri: r.bin }, who)).rejects.toThrow('not text');
  });

  it('outlines the primary form without the sections\' text', async () => {
    const r = await rig();
    const outline = await r.reader.outline(r.page, who);
    expect(outline.map((s) => [s.key, s.form])).toEqual([['Guide', 'markdown'], ['Guide > Usage', 'markdown']]);
    expect(outline.every((s) => s.embedText === undefined)).toBe(true);
    const whole = await r.reader.outline(ResourceUri.parse('file://main/blob.bin'), who).catch((error: unknown) => error);
    expect(whole).toBeInstanceOf(Error);
  });

  it('presigns downloads of the raw content and of a form as its text', async () => {
    const r = await rig();
    const raw = await r.reader.download(r.page, undefined, who);
    expect(raw).toMatchObject({ mime: 'text/html', size: PAGE.length });
    expect(raw.url).toContain('guide.html');
    const md = await r.reader.download(r.page, 'markdown', who);
    expect(md.mime).toBe('text/markdown');
    expect(md.url).toContain('guide.html.md');
  });
});
