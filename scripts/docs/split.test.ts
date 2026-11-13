import { describe, expect, it } from 'vitest';
import { cutPart, headingTitle, pieceSlug, sizeOf } from './split.ts';

/** A section of about `size` characters under a heading. */
const section = (level: number, title: string, size: number): string => `${'#'.repeat(level)} ${title}\n\n${'x'.repeat(size)}`;

describe('cutting a part', () => {
  it('leaves a part that fits alone', () => {
    expect(cutPart('## A\n\nshort', { budget: 100 })).toBeUndefined();
  });

  it('cuts at ### sections, packing small neighbours under the budget, and keeps the head with the part', () => {
    const text = ['## Part', 'Intro.', section(3, 'One', 300), section(3, 'Two', 300), section(3, 'Three', 300)].join('\n\n');
    const cut = cutPart(text, { budget: 900 });
    expect(cut?.head.trim()).toBe('## Part\n\nIntro.');
    expect(cut?.pieces.map((piece) => piece.names)).toEqual([['One', 'Two'], ['Three']]);
    expect(cut?.pieces[0]?.title).toBe('One … Two');
    expect(cut?.pieces.every((piece) => sizeOf(piece.text) <= 900)).toBe(true);
  });

  it('keeps every section whole with each, and ignores headings inside code fences', () => {
    const fenced = `### Two\n\n\`\`\`md\n### not a heading\n\`\`\`\n${'y'.repeat(200)}`;
    const text = ['## Part', section(3, 'One', 200), fenced].join('\n\n');
    expect(cutPart(text, { budget: 400, each: 'top' })?.pieces.map((piece) => piece.title)).toEqual(['One', 'Two']);
  });

  it('cuts a section too large at its next heading level, under its heading, then at its list items', () => {
    const big = [section(3, 'Reference', 10), section(4, '`a`', 300), section(4, '`b`', 300), section(4, '`c`', 300), section(4, '`d`', 300)].join('\n\n');
    const cut = cutPart(`## Part\n\n${big}`, { budget: 1000 });
    expect(cut?.pieces.map((piece) => piece.names)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(cut?.pieces.every((piece) => piece.text.startsWith('### Reference'))).toBe(true);
    const list = `#### Fns\n\n${['- `x/a`: one.', '- `x/b`: two.', '- `x/c`: three.'].map((line) => `${line} ${'z'.repeat(300)}`).join('\n')}`;
    expect(cutPart(`## Part\n\n${list}`, { budget: 800 })?.pieces.map((piece) => piece.names)).toEqual([['x/a', 'x/b'], ['x/c']]);
  });

  it('names headings and slugs plainly', () => {
    expect(headingTitle('#### <a id="core-x"></a>`Manifest`')).toBe('Manifest');
    expect(pieceSlug('From packages/core/src/manifest.ts')).toBe('manifest-ts');
    expect(pieceSlug('scripts/docs/example/server/impl.ts')).toBe('server-impl-ts');
    expect(pieceSlug('2. Things')).toBe('p2-things');
  });
});
