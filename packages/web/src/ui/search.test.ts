import { LIST_FIELDS } from '@harness/core';
import { describe, expect, it } from 'vitest';
import {
  buildFilter, findField, hasFilter, parseNumber, pillText, readFilter, readQuery, sortText, suggest, typing, withFilter, toggledFilter, withSort, withText, withoutFilter, words, writeQuery,
  type SearchQuery,
} from './search.ts';

const runs = LIST_FIELDS.runs.fields;
const fns = LIST_FIELDS.fns.fields;
const contexts = LIST_FIELDS.contexts.fields;
const usd = (value: number): string => `$${value}`;

describe('the written form', () => {
  it('reads fields by key or label in any case', () => {
    expect(findField(fns, 'averageCost')).toBe('averageCost');
    expect(findField(fns, 'Avg cost')).toBe('averageCost');
    expect(findField(fns, 'avgcost')).toBe('averageCost');
    expect(findField(fns, 'nope')).toBeUndefined();
  });

  it('reads every operator', () => {
    expect(readFilter(runs, 'status:running')).toEqual({ field: 'status', op: 'is', value: 'running' });
    expect(readFilter(runs, 'Status:Awaiting-approval')).toEqual({ field: 'status', op: 'is', value: 'awaiting-approval' });
    expect(readFilter(runs, 'status:running,queued')).toEqual({ field: 'status', op: 'in', values: ['running', 'queued'] });
    expect(readFilter(runs, 'status!:failed')).toEqual({ field: 'status', op: 'isNot', value: 'failed' });
    expect(readFilter(runs, 'status!:failed,cancelled')).toEqual({ field: 'status', op: 'notIn', values: ['failed', 'cancelled'] });
    expect(readFilter(runs, 'cost>0.01')).toEqual({ field: 'cost', op: 'gt', value: 0.01 });
    expect(readFilter(runs, 'cost>=$0.5')).toEqual({ field: 'cost', op: 'gte', value: 0.5 });
    expect(readFilter(runs, 'duration<2s')).toEqual({ field: 'duration', op: 'lt', value: 2_000 });
    expect(readFilter(runs, 'cost:1..2')).toEqual({ field: 'cost', op: 'between', from: 1, to: 2 });
    expect(readFilter(contexts, 'name~guide')).toEqual({ field: 'name', op: 'contains', value: 'guide' });
    expect(readFilter(contexts, 'no:tags')).toEqual({ field: 'tags', op: 'empty' });
    expect(readFilter(contexts, 'has:tags')).toEqual({ field: 'tags', op: 'notEmpty' });
    expect(readFilter(fns, 'paused:yes')).toEqual({ field: 'paused', op: 'is', value: true });
  });

  it('leaves words that are not filters for these fields as free text', () => {
    expect(readFilter(runs, 'status:nonsense')).toBeUndefined();
    expect(readFilter(runs, 'status:failed,nonsense')).toBeUndefined();
    expect(readFilter(runs, 'cost>cheap')).toBeUndefined();
    expect(readFilter(runs, 'status>1')).toBeUndefined();
    expect(readFilter(runs, 'colour:red')).toBeUndefined();
    expect(readQuery(runs, 'read status:failed the file')).toEqual({ text: 'read the file', filters: [{ field: 'status', op: 'is', value: 'failed' }] });
  });

  it('reads dates as days or times', () => {
    const filter = readFilter(runs, 'createdAt>2026-11-01');
    expect(filter).toEqual({ field: 'createdAt', op: 'gt', value: new Date(2026, 10, 1).getTime() });
  });

  it('writes a query that reads back the same, quoting values with spaces and commas', () => {
    const query = {
      text: 'hello world',
      filters: [
        { field: 'fn', op: 'is', value: 'my fn, two' },
        { field: 'status', op: 'in', values: ['running', 'queued'] },
        { field: 'cost', op: 'between', from: 0.01, to: 1 },
        { field: 'createdAt', op: 'gte', value: new Date(2026, 10, 1).getTime() },
        { field: 'session', op: 'notEmpty' },
      ],
      sort: [{ field: 'cost', dir: 'desc' }],
    } satisfies SearchQuery;
    const written = writeQuery(runs, query);
    expect(written).toBe('fn:"my fn, two" status:running,queued cost:0.01..1 createdAt>=2026-11-01 has:session sort:-cost hello world');
    expect(readQuery(runs, written)).toEqual(query);
  });

  it('keeps quoted words whole', () => {
    expect(words('a fn:"b c" "d')).toEqual(['a', 'fn:"b c"', '"d']);
  });

  it('reads units', () => {
    expect(parseNumber('1.5kb')).toBe(1_536);
    expect(parseNumber('12k')).toBe(12_000);
    expect(parseNumber('2 parsecs')).toBeUndefined();
  });
});

describe('quick filters', () => {
  it('toggles a filter on and off without touching the rest of the query', () => {
    const waiting = { field: 'status', op: 'is', value: 'awaiting-approval' } as const;
    const start: SearchQuery = { text: 'read', filters: [{ field: 'fn', op: 'is', value: 'fs/read' }] };
    const on = toggledFilter(start, waiting);
    expect(hasFilter(on, waiting)).toBe(true);
    expect(on.filters).toHaveLength(2);
    expect(toggledFilter(on, waiting)).toEqual(start);
    expect(toggledFilter({}, waiting)).toEqual({ filters: [waiting] });
    expect(toggledFilter({ filters: [waiting] }, waiting)).toEqual({});
  });
});

describe('pills', () => {
  it('reads like a sentence', () => {
    expect(pillText(runs, { field: 'status', op: 'is', value: 'awaiting-approval' })).toBe('Status: Awaiting approval');
    expect(pillText(runs, { field: 'cost', op: 'gt', value: 0.01 }, usd)).toBe('Cost > $0.01');
    expect(pillText(runs, { field: 'status', op: 'in', values: ['running', 'queued'] })).toBe('Status in Running, Queued');
    expect(pillText(contexts, { field: 'tags', op: 'empty' })).toBe('Tag is empty');
    expect(pillText(fns, { field: 'paused', op: 'is', value: false })).toBe('Paused: No');
    expect(pillText(runs, { field: 'cost', op: 'between', from: 1, to: 2 }, usd)).toBe('Cost $1 – $2');
  });

  it('builds a filter from the menu, refusing a value of the wrong type', () => {
    const cost = runs.cost;
    expect(buildFilter(cost, 'cost', 'gt', ['$0.01'])).toEqual({ field: 'cost', op: 'gt', value: 0.01 });
    expect(buildFilter(cost, 'cost', 'gt', ['cheap'])).toBeUndefined();
    expect(buildFilter(cost, 'cost', 'between', ['1'])).toBeUndefined();
    expect(buildFilter(runs.status, 'status', 'in', ['running', 'queued'])).toEqual({ field: 'status', op: 'in', values: ['running', 'queued'] });
    expect(buildFilter(runs.session, 'session', 'empty', [])).toEqual({ field: 'session', op: 'empty' });
  });

  it('adds, replaces and removes filters and words', () => {
    const one = { field: 'status', op: 'is', value: 'failed' } as const;
    const two = { field: 'cost', op: 'gt', value: 1 } as const;
    let query = withFilter({}, one);
    query = withFilter(query, one);
    expect(query.filters).toEqual([one]);
    query = withFilter(query, two, 0);
    expect(query.filters).toEqual([two]);
    expect(withoutFilter(query, 0)).toEqual({});
    expect(withText(query, '  hi ')).toEqual({ filters: [two], text: 'hi' });
    expect(withText({ text: 'hi' }, ' ')).toEqual({});
  });
});

describe('sort', () => {
  it('turns the current field round and starts others in their natural direction', () => {
    expect(withSort(runs, [{ field: 'createdAt', dir: 'desc' }], 'createdAt')).toEqual([{ field: 'createdAt', dir: 'asc' }]);
    expect(withSort(runs, [{ field: 'createdAt', dir: 'desc' }], 'cost')).toEqual([{ field: 'cost', dir: 'desc' }]);
    expect(withSort(fns, [], 'name')).toEqual([{ field: 'name', dir: 'asc' }]);
  });

  it('says the sort in words', () => {
    expect(sortText(runs, { field: 'createdAt', dir: 'desc' })).toBe('Started, newest first');
    expect(sortText(runs, { field: 'cost', dir: 'asc' })).toBe('Cost, lowest first');
    expect(sortText(fns, { field: 'name', dir: 'asc' })).toBe('Name, A to Z');
  });
});

describe('suggestions', () => {
  it('offers matching values as pills, fields, and the words as a search', () => {
    const got = suggest(runs, 'run', { fn: [{ value: 'fs/run', count: 3 }] });
    expect(got.map((s) => s.label)).toEqual(['Fn: fs/run', 'Status: Running', 'Search “run”']);
    expect(got[0]).toEqual({ kind: 'filter', filter: { field: 'fn', op: 'is', value: 'fs/run' }, label: 'Fn: fs/run', count: 3 });
  });

  it('offers fields by name', () => {
    expect(suggest(runs, 'dur', {}).map((s) => s.kind === 'field' ? s.field : s.kind)).toEqual(['duration', 'text']);
  });

  it('offers only a named field’s values after its colon', () => {
    expect(typing(runs, 'status:ru')).toEqual({ field: 'status', prefix: 'ru' });
    expect(suggest(runs, 'status:ru', {}).map((s) => s.label)).toEqual(['Status: Running']);
    expect(suggest(runs, 'status:', {}).length).toBeGreaterThan(3);
  });

  it('offers a whole filter typed out first', () => {
    expect(suggest(runs, 'cost>0.5', {}, usd)[0]).toEqual({ kind: 'filter', filter: { field: 'cost', op: 'gt', value: 0.5 }, label: 'Cost > $0.5' });
  });
});
