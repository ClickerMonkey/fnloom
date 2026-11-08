import { describe, expect, it } from 'vitest';
import { moreEdges } from './edges.ts';

describe('a sideways strip’s faded ends', () => {
  it('fades the end with more beyond it, both in the middle, none when it all fits', () => {
    expect(moreEdges(0, 300, 300)).toBe('');
    expect(moreEdges(0, 300, 600)).toBe('end');
    expect(moreEdges(150, 300, 600)).toBe('both');
    expect(moreEdges(300, 300, 600)).toBe('start');
    // a pixel of rounding is not more
    expect(moreEdges(0.5, 300, 300.6)).toBe('');
  });
});
