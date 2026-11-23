import { describe, expect, it } from 'vitest';
import { imageBlock, imageSize } from './images.ts';

/** Bytes from numbers and text. */
function b(...parts: Array<number | string>): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => (typeof part === 'number' ? [part] : [...part].map((c) => c.charCodeAt(0)))));
}

describe('an image\'s size from its first bytes', () => {
  it('reads PNG, GIF, JPEG and WebP', () => {
    expect(imageSize(b(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR', 0, 0, 2, 0x80, 0, 0, 1, 0xe0))).toEqual({ width: 640, height: 480 });
    expect(imageSize(b('GIF89a', 0x20, 0x03, 0x58, 0x02))).toEqual({ width: 800, height: 600 });
    // SOI, an APP0 segment of 16 bytes, then a baseline frame: precision, height 300, width 400
    const app0 = [0xff, 0xe0, 0, 16, ...new Array<number>(14).fill(0)];
    expect(imageSize(b(0xff, 0xd8, ...app0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x2c, 0x01, 0x90, 3))).toEqual({ width: 400, height: 300 });
    const vp8x = b('RIFF', 0, 0, 0, 0, 'WEBP', 'VP8X', 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0, 0x57, 0x02, 0);
    expect(imageSize(vp8x)).toEqual({ width: 800, height: 600 });
  });

  it('says nothing for bytes it doesn\'t know', () => {
    expect(imageSize(b('hello world, not an image'))).toBeUndefined();
    expect(imageSize(new Uint8Array())).toBeUndefined();
  });
});

describe('the block a model that can\'t see reads', () => {
  it('names the image, its facts and the one call that asks about it', () => {
    const block = imageBlock({ id: 'hub://resources/uploads/2026-11-23/a "b".png', name: 'a "b".png', mime: 'image/png', size: 10, dimensions: { width: 2, height: 3 }, source: 'attached to a message', answerable: true });
    expect(block).toContain('id="hub://resources/uploads/2026-11-23/a &quot;b&quot;.png" name="a &quot;b&quot;.png" mime="image/png" size="10" width="2" height="3" source="attached to a message"');
    expect(block).toContain('{"image": "hub://resources/uploads/2026-11-23/a \\"b\\".png", "question": "<what you need to know>"}');
    expect(block.endsWith('</image>')).toBe(true);
  });
});
