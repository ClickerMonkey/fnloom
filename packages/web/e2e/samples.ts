/**
 * Sample files of every common type, made in code so they are real files without binaries in the repository: a
 * png (a gradient, zlib-compressed), a wav (a second of a tone), a one-page pdf with its cross-reference table,
 * markdown with a diagram and math, TypeScript, csv, an svg, an html page, json and a log. The mock hub serves them
 * as resources and the UI feature scripts upload them to a real hub.
 */
import { crc32, deflateSync } from 'node:zlib';

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A small png: a soft diagonal gradient, made with zlib so it is a real image. */
export function png(width: number, height: number): Uint8Array {
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0);
    for (let x = 0; x < width; x++) { rows.push(59 + Math.round((x / width) * 80), 130 + Math.round((y / height) * 60), 246 - Math.round((x / width) * 60)); }
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(utf8(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(new Uint8Array(rows))), chunk('IEND', new Uint8Array())];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A second of a 440 Hz tone as a wav. */
export function wav(): Uint8Array {
  const rate = 8_000;
  const samples = rate;
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  out.set(utf8('RIFF'), 0); view.setUint32(4, 36 + samples * 2, true); out.set(utf8('WAVEfmt '), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); out.set(utf8('data'), 36); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) { view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8_000 * Math.min(1, (samples - i) / 800)), true); }
  return out;
}

/** A one-page pdf with a line of text, with its cross-reference table worked out. */
export function pdf(): Uint8Array {
  const stream = 'BT /F1 24 Tf 72 720 Td (Harness guide) Tj ET BT /F1 12 Tf 72 690 Td (A hub and its systems.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return utf8(body);
}

export const MARKDOWN = `# Harness

A web-based agent harness: one **hub** that owns every model call, and **systems** that add fns, types and resources.

\`\`\`mermaid
graph LR
  Chat --> Hub --> fs
  Hub --> web
\`\`\`

The prompt fits the window: $B = W - O - M$.

$$\\sum_{i=1}^{n} w_i \\cdot \\frac{s_i}{\\sqrt{t_i}}$$

See [the guide](fs://work/docs/guide.pdf).
`;

export const CODE = `import { createApp } from 'vue';
import App from './app/App.vue';

/** Start the app. */
export function start(root: string): void {
  createApp(App).mount(root);
}
`;

export const CSV = 'name,age,joined\nAda,36,2024-01-04\nGrace,45,2023-06-12\n"Hopper, Grace",46,2023-06-13\nAlan,41,2025-02-20\n';
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" rx="16" fill="#3b82f6"/><circle cx="80" cy="80" r="40" fill="#fff" opacity=".85"/><rect x="132" y="48" width="72" height="64" rx="10" fill="#fff" opacity=".6"/></svg>';
export const HTML = '<!doctype html><html><head><title>Release notes</title></head><body style="font-family: system-ui; padding: 16px"><h1>Release notes</h1><p>The <b>fs</b> system can watch folders.</p><ul><li>Faster search</li><li>Live runs</li></ul></body></html>';
export const JSON_TEXT = JSON.stringify({ name: 'harness', private: true, workspaces: ['packages/core', 'packages/sdk', 'packages/hub', 'packages/web'], engines: { node: '>=22.18' }, scripts: { dev: 'tsx scripts/dev.ts', test: 'vitest run' } }, null, 2);
export const LOG = Array.from({ length: 40 }, (_, i) => `2026-11-07T12:${String(i).padStart(2, '0')}:00Z info run.settled run=run_${i} status=done`).join('\n');

/** One sample file: its name, media type and bytes. */
export interface SampleFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/** One file of each common type, to upload. */
export function sampleFiles(): SampleFile[] {
  return [
    { name: 'ui-sample.md', mime: 'text/markdown', bytes: utf8(MARKDOWN) },
    { name: 'ui-sample.ts', mime: 'text/typescript', bytes: utf8(CODE) },
    { name: 'ui-sample.csv', mime: 'text/csv', bytes: utf8(CSV) },
    { name: 'ui-sample.json', mime: 'application/json', bytes: utf8(JSON_TEXT) },
    { name: 'ui-sample.svg', mime: 'image/svg+xml', bytes: utf8(SVG) },
    { name: 'ui-sample.html', mime: 'text/html', bytes: utf8(HTML) },
    { name: 'ui-sample.log', mime: 'text/plain', bytes: utf8(LOG) },
    { name: 'ui-sample.png', mime: 'image/png', bytes: png(96, 64) },
    { name: 'ui-sample.pdf', mime: 'application/pdf', bytes: pdf() },
    { name: 'ui-sample.wav', mime: 'audio/wav', bytes: wav() },
  ];
}
