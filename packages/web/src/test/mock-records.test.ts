// @vitest-environment node
/**
 * The mock hub's stored data: every type the data tab lists opens on as many records as its count says, a page at a
 * time, the way the hub counts and lists from one records table.
 */
import { QualifiedName, RecordId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MockData } from '../../e2e/mockBuild8.ts';
import { TASK_TYPE } from '../../e2e/mockRecords.ts';

const AT = Date.UTC(2026, 10, 14);

describe('the mock data tab', () => {
  it('lists every type with the count of records opening it shows', () => {
    const data = new MockData(() => AT);
    const sets = data.sets({}).items;
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      const all = data.table({ type: set.type, offset: 0, limit: 1_000 });
      expect(all.rows, set.type).toHaveLength(set.records);
      expect(set.records, set.type).toBeGreaterThan(0);
      // the rows are the type's records, each opening as one
      const id = all.rows[0]?.at(-1);
      expect(data.record({ type: set.type, id: RecordId.parse(id) }).record?.type).toBe(set.type);
    }
  });

  it('pages the 128 tasks, and keeps the count in step as records are added and removed', () => {
    const data = new MockData(() => AT);
    const count = (): number => data.sets({}).items.find((set) => set.type === TASK_TYPE)?.records ?? -1;
    expect(count()).toBe(128);
    const first = data.table({ type: TASK_TYPE, offset: 0, limit: 50 });
    expect(first.rows).toHaveLength(50);
    expect(first.truncated).toBe(true);
    expect(data.table({ type: TASK_TYPE, offset: 100, limit: 50 }).rows).toHaveLength(28);
    const made = data.save({ type: TASK_TYPE, value: { title: 'Rake the leaves', status: 'open', assignee: 'Phil', due_date: '2026-11-20', points: 2 } }, 'act_admin');
    expect(count()).toBe(129);
    data.remove({ type: TASK_TYPE, id: made.id });
    expect(count()).toBe(128);
    expect(data.table({ type: QualifiedName.parse('nobody/Nothing') }).rows).toEqual([]);
  });
});
