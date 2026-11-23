import { describe, expect, it } from 'vitest';
import { clipMarked, cutMarker, partialNote } from './partial.ts';

describe('saying a result is partial', () => {
  it('says what part is here, how much was left out and how to get the rest', () => {
    expect(partialNote({ unit: 'characters', offset: 0, shown: 4_000, total: 12_345, rest: 'read on with offset: 4000' })).toBe(
      'Partial: characters 1–4,000 of 12,345 are here; 8,345 characters were left out. To get the rest, read on with offset: 4000. Don\'t state what the left-out part says.',
    );
    expect(partialNote({ unit: 'rows', offset: 10, shown: 1, total: 12, rest: 'page on' })).toBe(
      'Partial: row 11 of 12 is here; 11 rows were left out (10 before this part, 1 after it). To get the rest, page on. Don\'t state what the left-out part says.',
    );
    expect(partialNote({ unit: 'lines', offset: 3, shown: 2, total: 5, rest: 'read from 0' })).toContain('3 lines were left out (all before this part)');
    expect(partialNote({ unit: 'rows', offset: 0, shown: 50, rest: 'page on' })).toContain('rows 1–50 are here; more follow (how many is not known)');
  });

  it('says nothing of a whole result', () => {
    expect(partialNote({ unit: 'characters', offset: 0, shown: 10, total: 10, rest: 'x' })).toBeUndefined();
  });

  it('cuts a text with a marker of how much was cut, at a word when asked', () => {
    expect(clipMarked('short', 10)).toBe('short');
    expect(clipMarked('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij…[16 more characters cut]');
    expect(clipMarked('one two three four five six', 15, { atWord: true, rest: 'read the page' })).toBe('one two three…[14 more characters cut: read the page]');
    expect(cutMarker(1, undefined, 'bytes')).toBe('…[1 more byte cut]');
  });
});
