import { citeMarker, IDS, type Citation } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../ui/markdown/parse.ts';
import { citeAria, citeState, citesNothing, pathLabel, readableValue } from './cites.ts';
import { messageText } from './thread.ts';
import type { RunView } from './runs.ts';

const run = IDS.run.parse('run_1');
const resolved: Citation = { index: 1, number: 3, tool: 'run_1', path: 'items.0', note: 'the first item', run, fn: 'fs/read', found: 'result', value: { due: '2026-11-27', done: false } };
const view: RunView = { id: run, fn: 'fs/read', status: 'done', cost: 0, totalCost: 0, attempt: 1, background: false, errors: [], outcome: { status: 'done', result: { big: { a: [1, 2] } } } };

describe('a cite chip', () => {
  it('is pending while it streams, shows its value, reads a large one from the run, and says why it does not resolve', () => {
    expect(citeState({ index: 1, number: 1, tool: 'run_1', path: '', note: '' }, undefined)).toEqual({ kind: 'pending' });
    expect(citeState(resolved, undefined)).toEqual({ kind: 'value', value: { due: '2026-11-27', done: false } });
    const large: Citation = { index: 1, number: 1, tool: 'run_1', path: 'big.a', note: '', run, large: true };
    expect(citeState(large, view)).toEqual({ kind: 'value', value: [1, 2] });
    expect(citeState(large, undefined)).toEqual({ kind: 'unloaded' });
    const missing: Citation = { index: 1, number: 2, tool: 'run_x', path: 'a', note: '', problem: 'No tool call of this chat has the id run_x.' };
    expect(citeState(missing, undefined)).toEqual({ kind: 'problem', problem: 'No tool call of this chat has the id run_x.' });
    expect(citeAria(missing)).toBe('Citation 2, not found');
    expect(pathLabel('')).toBe('the whole result');
  });

  it('shows a value for people: fields, items, text, or JSON when deep', () => {
    expect(readableValue({ due: '2026-11-27', done: false })).toEqual({
      kind: 'fields', fields: [{ key: 'due', label: 'Due', text: '2026-11-27', long: false }, { key: 'done', label: 'Done', text: 'No', long: false }],
    });
    expect(readableValue(['a', 2])).toEqual({ kind: 'items', items: ['a', '2'] });
    expect(readableValue('Lisbon')).toEqual({ kind: 'text', text: 'Lisbon' });
    expect(readableValue([{ a: 1 }]).kind).toBe('json');
  });

  it('says "No citations" only for a settled answer given with citations on that cites nothing', () => {
    expect(citesNothing([{ status: 'done', citations: [] }])).toBe(true);
    expect(citesNothing([{ status: 'done', citations: [resolved] }])).toBe(false);
    expect(citesNothing([{ status: 'done' }])).toBe(false);
    expect(citesNothing([{ status: 'streaming', citations: [] }])).toBe(false);
  });
});

describe('cite markers in text', () => {
  it('parse as cite nodes inside markdown, and copy as [n]', () => {
    const blocks = parseMarkdown(`Due **Friday**${citeMarker(1)}.`);
    expect(blocks).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'Due ' }, { type: 'strong', children: [{ type: 'text', text: 'Friday' }] }, { type: 'cite', index: 1 }, { type: 'text', text: '.' }] }]);
    expect(messageText([{ type: 'text', text: `Due Friday${citeMarker(1)}.` }], [resolved])).toBe('Due Friday[3].');
    expect(messageText([{ type: 'text', text: `Due${citeMarker(1)}` }])).toBe('Due');
  });
});
