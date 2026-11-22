import { g, type GinType } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { repairArgs } from './arg-repair.ts';

/** Args schemas as the catalog makes them: a gin type's value schema, unknown keys refused. */
const schemaOf = (type: GinType): z.ZodType => type.toValueSchema({ unknownKeys: 'refuse' });

const Query = schemaOf(g.obj({
  fn: g.text(),
  args: g.optional(g.obj({ status: g.text(), limit: g.optional(g.num()) })),
  sort: g.optional(g.list(g.obj({ column: g.text(), dir: g.enum(['asc', 'desc']) }))),
  note: g.optional(g.text()),
}));

describe('args sent as a string holding JSON', () => {
  it('reads an object sent as a string holding it, and says where', () => {
    const repaired = repairArgs(Query, { fn: 'q', args: '{"status":"paid","limit":5}' });
    expect(repaired).toEqual({ args: { fn: 'q', args: { status: 'paid', limit: 5 } }, repairs: [{ path: 'args', repair: 'json-string' }] });
    expect(Query.safeParse(repaired.args).success).toBe(true);
  });

  it('reads a list sent as a string holding it', () => {
    const repaired = repairArgs(Query, { fn: 'q', sort: ' [{"column":"customer","dir":"asc"}]' });
    expect(repaired.args).toEqual({ fn: 'q', sort: [{ column: 'customer', dir: 'asc' }] });
    expect(repaired.repairs).toEqual([{ path: 'sort', repair: 'json-string' }]);
  });

  it('reads nested strings: a list in an object, and an item of a list', () => {
    const Nested = schemaOf(g.obj({ rows: g.list(g.obj({ tags: g.list(g.text()) })) }));
    const whole = repairArgs(Nested, { rows: JSON.stringify([{ tags: '["a","b"]' }]) });
    expect(whole.args).toEqual({ rows: [{ tags: ['a', 'b'] }] });
    expect(whole.repairs).toEqual([{ path: 'rows', repair: 'json-string' }, { path: 'rows.0.tags', repair: 'json-string' }]);
    const item = repairArgs(Nested, { rows: [{ tags: ['a'] }, '{"tags":["c"]}'] });
    expect(item).toEqual({ args: { rows: [{ tags: ['a'] }, { tags: ['c'] }] }, repairs: [{ path: 'rows.1', repair: 'json-string' }] });
  });

  it('leaves a string that is not JSON, or JSON of the wrong shape, as sent (still invalid)', () => {
    for (const args of [{ fn: 'q', args: ':{' }, { fn: 'q', args: 'status=paid' }, { fn: 'q', args: '[1, 2]' }, { fn: 'q', sort: '{"column":"a","dir":"asc"}' }]) {
      const repaired = repairArgs(Query, args);
      expect(repaired).toEqual({ args, repairs: [] });
      expect(Query.safeParse(repaired.args).success).toBe(false);
    }
  });

  it('leaves a text field holding JSON alone, and args that already fit untouched', () => {
    const asText = { fn: 'q', note: '{"status":"paid"}' };
    expect(repairArgs(Query, asText)).toEqual({ args: asText, repairs: [] });
    // the text field stays text even while another field is repaired
    expect(repairArgs(Query, { ...asText, args: '{"status":"open"}' })).toEqual({
      args: { fn: 'q', note: '{"status":"paid"}', args: { status: 'open' } }, repairs: [{ path: 'args', repair: 'json-string' }],
    });
    const Loose = schemaOf(g.obj({ value: g.any() }));
    expect(repairArgs(Loose, { value: '{"a":1}' })).toEqual({ args: { value: '{"a":1}' }, repairs: [] });
  });

  it('reads an open-key record (record<V>, run_query\'s args) sent as a string holding its object, and its values', () => {
    const RunQuery = schemaOf(g.obj({ fn: g.text(), args: g.optional(g.record(g.any())) }));
    expect(repairArgs(RunQuery, { fn: 'q', args: '{"spent_on":"2026-11-21","amount":172.48}' })).toEqual({
      args: { fn: 'q', args: { spent_on: '2026-11-21', amount: 172.48 } }, repairs: [{ path: 'args', repair: 'json-string' }],
    });
    // a list is not the object a record wants, and broken JSON stays as sent
    expect(repairArgs(RunQuery, { fn: 'q', args: '[{"key":"a","value":1}]' }).repairs).toEqual([]);
    expect(repairArgs(RunQuery, { fn: 'q', args: ':{' }).repairs).toEqual([]);
    const Lists = schemaOf(g.obj({ bind: g.record(g.list(g.text())) }));
    expect(repairArgs(Lists, { bind: { x: '["stage"]' } })).toEqual({ args: { bind: { x: ['stage'] } }, repairs: [{ path: 'bind.x', repair: 'json-string' }] });
  });

  it('takes a union member that is text as text, and repairs into an object member otherwise', () => {
    const Either = schemaOf(g.obj({ target: g.or([g.text(), g.obj({ id: g.num() })]) }));
    expect(repairArgs(Either, { target: '{"id":1}' }).repairs).toEqual([]);
    const ObjectOrList = schemaOf(g.obj({ target: g.or([g.obj({ id: g.num() }), g.list(g.num())]) }));
    expect(repairArgs(ObjectOrList, { target: '[1,2]' })).toEqual({ args: { target: [1, 2] }, repairs: [{ path: 'target', repair: 'json-string' }] });
  });
});
