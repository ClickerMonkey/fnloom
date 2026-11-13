import { describe, expect, it } from 'vitest';
import { queryable, recordFields } from './fields.ts';

describe('record fields', () => {
  // a claude/Session's status is an enum: the fleet page and the claude system's restart sweep filter on it
  it('reads an enum field as its value type, so it can be filtered', () => {
    const fields = recordFields({
      name: 'obj',
      props: {
        status: { type: { name: 'enum', generic: { V: { name: 'text' } }, options: { values: { idle: 'idle', working: 'working' } } } },
        tasks: { type: { name: 'list', generic: { V: { name: 'text' } } } },
      },
    });
    expect(fields.map((field) => [field.name, field.kind, queryable(field)])).toEqual([['status', 'text', true], ['tasks', 'json', false]]);
  });
});
