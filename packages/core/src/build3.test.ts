import { describe, expect, it } from 'vitest';
import { LIST_FIELDS, LIST_NAMES, ListQuery, OPS_BY_TYPE, StoredSuggestDecision, SUGGEST_DECISION_DEFAULT, SuggestDecision, queryProblems, sortOf } from './index.ts';

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

describe('the suggestions setting', () => {
  it('is one choice: no model, a decision model (its own or the decide role\'s) or an LLM, which needs a model', () => {
    expect(SUGGEST_DECISION_DEFAULT).toEqual({ by: 'none' });
    expect(SuggestDecision.parse({ by: 'decision' })).toMatchObject({ by: 'decision', messages: 3, candidates: 20, cap: 6, floor: 0.35 });
    expect(SuggestDecision.safeParse({ by: 'llm' }).success).toBe(false);
    expect(SuggestDecision.parse({ by: 'llm', model: { model: { model: 'tiny' } } })).toMatchObject({ by: 'llm', model: { model: { model: 'tiny' } } });
  });

  it('reads a setting stored before as today\'s: on with a model is an LLM, anything else no model', () => {
    const legacy = { enabled: true, model: { model: { model: 'tiny' } }, messages: 2, candidates: 10, cap: 3, floor: 0.4 };
    expect(StoredSuggestDecision.parse(legacy)).toEqual({ by: 'llm', model: { model: { model: 'tiny' } }, messages: 2, candidates: 10, cap: 3, floor: 0.4 });
    expect(StoredSuggestDecision.parse({ ...legacy, enabled: false })).toEqual({ by: 'none' });
    expect(StoredSuggestDecision.parse({ enabled: true, messages: 3, candidates: 20, cap: 6, floor: 0.35 })).toEqual({ by: 'none' });
    expect(StoredSuggestDecision.parse({ by: 'decision' })).toMatchObject({ by: 'decision', floor: 0.35 });
  });
});
