/**
 * Page pictures read out of a pdf (`pdf-pages.ts`): a scan's pages are pictures with no text, and the only way to
 * know what they say is to look at them.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng, pdfPictures } from './pdf-pages.ts';
import { bytes, madePdf } from './testing.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

/** A PNG's width, height, bit depth, colour type and its rows' samples (each led by its filter byte). */
function readPng(png: Uint8Array): { width: number; height: number; bits: number; colorType: number; rows: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let header = { width: 0, height: 0, bits: 0, colorType: 0 };
  const data: Uint8Array[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = Buffer.from(png.subarray(at + 4, at + 8)).toString('latin1');
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { header = { width: view.getUint32(at + 8), height: view.getUint32(at + 12), bits: body[8] ?? 0, colorType: body[9] ?? 0 }; }
    if (type === 'IDAT') { data.push(body); }
    at += 12 + length;
  }
  return { ...header, rows: new Uint8Array(inflateSync(Buffer.concat(data))) };
}

describe('the pictures a pdf\'s pages are', () => {
  it('reads each page\'s picture in page order: a JPEG as it is, a bitmap as a PNG', () => {
    const grey = new Uint8Array([0, 64, 128, 255]);
    const pdf = madePdf([
      { kind: 'jpeg', width: 300, height: 400, bytes: JPEG },
      { kind: 'bitmap', width: 2, height: 2, channels: 1, samples: grey },
      { kind: 'text', text: 'A page of real text' },
    ]);
    const pictures = pdfPictures(pdf);
    expect(pictures.pages).toBe(3);
    expect(pictures.images[0]).toMatchObject({ page: 1, mime: 'image/jpeg', width: 300, height: 400 });
    expect([...(pictures.images[0]?.bytes ?? [])]).toEqual([...JPEG]);
    const second = pictures.images[1];
    expect(second).toMatchObject({ page: 2, mime: 'image/png', width: 2, height: 2 });
    const png = readPng(second?.bytes ?? new Uint8Array());
    expect(png).toMatchObject({ width: 2, height: 2, bits: 8, colorType: 0 });
    expect([...png.rows]).toEqual([0, 0, 64, 0, 128, 255]);
    // a page of text has no picture
    expect(pictures.images[2]).toBeUndefined();
  });

  it('lays a picture\'s soft mask over white, as a scan printed to pdf has one', () => {
    const red = new Uint8Array([255, 0, 0, 255, 0, 0]);
    const pdf = madePdf([{ kind: 'bitmap', width: 2, height: 1, channels: 3, samples: red, alpha: new Uint8Array([255, 0]) }]);
    const png = readPng(pdfPictures(pdf).images[0]?.bytes ?? new Uint8Array());
    expect(png).toMatchObject({ width: 2, height: 1, colorType: 2 });
    // the first pixel is opaque red, the second fully see-through: white
    expect([...png.rows]).toEqual([0, 255, 0, 0, 255, 255, 255]);
  });

  it('has no pictures for what isn\'t a pdf it can read, and never throws', () => {
    expect(pdfPictures(bytes('not a pdf at all'))).toEqual({ pages: 0, images: [] });
    expect(pdfPictures(new Uint8Array())).toEqual({ pages: 0, images: [] });
    const cut = madePdf([{ kind: 'jpeg', width: 3, height: 3, bytes: JPEG }]).subarray(0, 120);
    expect(() => pdfPictures(cut)).not.toThrow();
  });

  it('writes a PNG of grey or RGB rows', () => {
    const png = readPng(encodePng(new Uint8Array([1, 2, 3, 4, 5, 6]), 1, 2, 3, 8, 2));
    expect(png).toMatchObject({ width: 1, height: 2, bits: 8, colorType: 2 });
    expect([...png.rows]).toEqual([0, 1, 2, 3, 0, 4, 5, 6]);
  });
});
