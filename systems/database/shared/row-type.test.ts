import { describe, expect, it } from 'vitest';
import { toRowType } from './row-type.ts';

const props = (value: unknown) => {
  const read = toRowType(value);
  return 'type' in read ? read.type.props : read.problem;
};

describe('toRowType', () => {
  it('keeps a gin obj type with props as it is', () => {
    const type = { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } } } };
    expect(toRowType(type)).toEqual({ type });
  });

  it('reads a column map, with ? for a column that may be empty', () => {
    expect(props({ id: 'integer', title: 'string', done: 'Boolean', due: 'date?', at: 'datetime', meta: 'json' })).toEqual({
      id: { type: { name: 'num', options: { whole: true } } },
      title: { type: { name: 'text' } },
      done: { type: { name: 'bool' } },
      due: { type: { name: 'optional', generic: { T: { name: 'date' } } } },
      at: { type: { name: 'timestamp' } },
      meta: { type: { name: 'any' } },
    });
  });

  it('reads a column named "name" as a column, not as a gin type', () => {
    expect(props({ name: 'text', price: 'number' })).toEqual({ name: { type: { name: 'text' } }, price: { type: { name: 'num' } } });
  });

  it('reads the JSON string and the key/value list the owner\'s model sent', () => {
    expect(props('{"id":"string","completed":"boolean"}')).toEqual({ id: { type: { name: 'text' } }, completed: { type: { name: 'bool' } } });
    expect(props([{ key: 'id', value: 'integer' }, { name: 'title', type: 'text' }])).toEqual({ id: { type: { name: 'num', options: { whole: true } } }, title: { type: { name: 'text' } } });
  });

  it('takes an obj given the table\'s name, and gin types as column types', () => {
    expect(props({ name: 'Todo', props: { id: { type: { name: 'text' } } } })).toEqual({ id: { type: { name: 'text' } } });
    expect(props({ id: { name: 'num' } })).toEqual({ id: { type: { name: 'num' } } });
  });

  it('refuses what has no one meaning, saying what to send', () => {
    for (const value of [null, undefined, 'todo', '"todo"', 42, [], {}, { name: 'obj' }, { id: 'sometimes' }, [{ value: 'text' }]]) {
      const read = toRowType(value);
      expect('problem' in read ? read.problem : read, JSON.stringify(value)).toContain('Send `type` as an object of column name to column type');
    }
  });
});
