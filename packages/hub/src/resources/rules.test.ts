import { ResourceUri, SystemName, type ResourceRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { facetsOf, groupOf } from './browse.ts';
import { estimateTokens, hubUri, isHubUri, madeKindsFor, primaryOf, safePath, textOf, withoutCredentials } from './rules.ts';
import { statOf } from './testing.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 7, 12);

function record(uri: string, fields: Partial<ResourceRecord> = {}, modifiedAt?: number): ResourceRecord {
  return { uri: ResourceUri.parse(uri), system: SystemName.parse('fs'), stat: statOf(uri, modifiedAt === undefined ? {} : { modifiedAt }), links: [], seenAt: NOW, ...fields };
}

describe('form rules', () => {
  it('picks the converted form first, then the family\'s model-made one, else the raw text', () => {
    expect(primaryOf('web', ['markdown'])).toBe('markdown');
    expect(primaryOf('image', ['ocr', 'description'])).toBe('description');
    expect(primaryOf('image', ['ocr'])).toBe('ocr');
    expect(primaryOf('audio', ['transcript'])).toBe('transcript');
    expect(primaryOf('code', [])).toBeUndefined();
    expect(madeKindsFor('video')).toEqual(['transcript']);
    expect(madeKindsFor('table')).toEqual([]);
  });

  it('reads text only from text bytes, and sizes it', () => {
    expect(textOf(new TextEncoder().encode('héllo'))).toBe('héllo');
    expect(textOf(new Uint8Array([104, 0, 105]))).toBeUndefined();
    expect(textOf(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined();
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('names hub resources safely', () => {
    expect(isHubUri('hub://resources/a')).toBe(true);
    expect(isHubUri('file://main/a')).toBe(false);
    expect(safePath('../a//b/./c')).toBe('a/b/c');
    expect(hubUri('uploads/2026-11-07', 'my notes.md')).toBe('hub://resources/uploads/2026-11-07/my%20notes.md');
  });

  it('leaves credentials out of what a URL shows', () => {
    expect(withoutCredentials('https://u:p@site.dev/a?api_key=1&token=2&page=3').href).toBe('https://site.dev/a?page=3');
  });
});

describe('groups', () => {
  it('groups by date relative to now', () => {
    const at = (offset: number) => groupOf(record('file://main/a', {}, NOW - offset), 'date', { now: NOW }).value;
    expect([at(0), at(DAY), at(3 * DAY), at(40 * DAY)]).toEqual(['today', 'yesterday', 'week', '2026-09']);
  });

  it('groups web pages by host and fn outputs by fn', () => {
    const page = record('hub://resources/web/site.dev/a', { source: { from: 'web', url: 'https://site.dev/a', fetchedAt: 1, rendered: false } });
    const out = record('hub://resources/runs/run_1/x.png', { source: { from: 'run', run: 'run_1', fn: 'art/draw' } });
    expect(facetsOf([page, out, page], 'source', { now: NOW })).toEqual([
      { value: 'web:site.dev', label: 'site.dev', count: 2 }, { value: 'run:art/draw', label: 'art/draw', count: 1 },
    ]);
  });

  it('groups by the next folder below the one looked at', () => {
    const rows = [record('file://main/docs/a/1.md'), record('file://main/docs/a/2.md'), record('file://main/docs/b.md')];
    expect(facetsOf(rows, 'path', { under: 'file://main/docs/', now: NOW })).toEqual([
      { value: 'file://main/docs/a/', label: 'a', count: 2 }, { value: '', label: 'Here', count: 1 },
    ]);
  });
});
