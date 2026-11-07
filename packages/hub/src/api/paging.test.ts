import { describe, expect, it } from 'vitest';
import { collect, first, type PageReader } from './paging.ts';

/** A reader over `items` in pages of `size`, recording which cursors it was asked for. */
function pages(items: readonly number[], size: number): { read: PageReader<number>; asked: Array<string | undefined> } {
  const asked: Array<string | undefined> = [];
  const read: PageReader<number> = (cursor) => {
    asked.push(cursor);
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + size;
    return Promise.resolve({ items: items.slice(start, end), ...(end < items.length ? { cursor: String(end) } : {}) });
  };
  return { read, asked };
}

describe('collect', () => {
  it('reads every page', async () => {
    const { read, asked } = pages([1, 2, 3, 4, 5], 2);
    await expect(collect(read)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(asked).toEqual([undefined, '2', '4']);
  });

  it('stops at the most it may read', async () => {
    const { read, asked } = pages([1, 2, 3, 4, 5], 2);
    await expect(collect(read, 3)).resolves.toEqual([1, 2, 3]);
    expect(asked).toHaveLength(2);
  });
});

describe('first', () => {
  it('stops reading once a row matches', async () => {
    const { read, asked } = pages([1, 2, 3, 4, 5], 2);
    await expect(first(read, (n) => n === 3)).resolves.toBe(3);
    expect(asked).toEqual([undefined, '2']);
  });

  it('is undefined when nothing matches', async () => {
    const { read } = pages([1, 2], 1);
    await expect(first(read, (n) => n > 5)).resolves.toBeUndefined();
  });
});
