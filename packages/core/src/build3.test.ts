import { describe, expect, it } from 'vitest';
import { LIST_FIELDS, LIST_NAMES, ListQuery, OPS_BY_TYPE, SuggestDecision, queryProblems, sortOf } from './index.ts';

describe('the query standard', () => {
  it('declares a default sort on a sortable field of every list', () => {
    for (const list of LIST_NAMES) {
      const fields: Record<string, { sortable: boolean }> = LIST_FIELDS[list].fields;
      for (const sort of LIST_FIELDS[list].defaultSort) { expect(fields[sort.field]?.sortable).toBe(true); }
    }
  });

  it('refuses unknown fields and operators the field type does not take', () => {
    const query = ListQuery.parse({ filters: [{ field: 'cost', op: 'gt', value: 0.01 }, { field: 'status', op: 'gt', value: 1 }, { field: 'nope', op: 'empty' }], sort: [{ field: 'nope', dir: 'asc' }] });
    expect(queryProblems('runs', query)).toHaveLength(3);
    expect(queryProblems('runs', ListQuery.parse({ filters: [{ field: 'status', op: 'in', values: ['running', 'queued'] }] }))).toEqual([]);
    expect(OPS_BY_TYPE.boolean).toEqual(['is']);
  });

  it('falls back to the list default sort', () => {
    expect(sortOf('runs', {})).toEqual([{ field: 'createdAt', dir: 'desc' }]);
    expect(sortOf('runs', { sort: [{ field: 'cost', dir: 'asc' }] })).toEqual([{ field: 'cost', dir: 'asc' }]);
  });
});

describe('the decision model setting', () => {
  it('is off by default and needs a model to turn on', () => {
    expect(SuggestDecision.parse({})).toMatchObject({ enabled: false, messages: 3 });
    expect(SuggestDecision.safeParse({ enabled: true }).success).toBe(false);
  });
});
