/**
 * Visuals a system contributes to another system's registry: `client()` takes only declared contributions, and the
 * client runtime lists the visuals that fit a result, best first, the table last, leaving out a match that throws.
 */
import { mintId, TABLE_VISUAL_SCORE, type ResultTable } from '@harness/core';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { client, type VisualView } from './client.ts';
import { ClientRuntime } from './client-runtime.ts';
import { g } from './gin.ts';
import { system } from './system.ts';

const REGISTRY = 'database/query-visuals';
const TableView = (view: VisualView) => h('table', String(view.table.rows.length));
const ValueView = (view: VisualView) => h('strong', String(view.table.rows[0]?.[0]));
const BrokenView = () => h('div');

const database = system('database', {
  description: 'Databases.',
  registries: { 'query-visuals': { description: 'Ways to draw rows.', data: g.obj({}) } },
  contributes: [{ registry: REGISTRY, name: 'table', label: 'Table' }, { registry: REGISTRY, name: 'value', label: 'Value' }],
});
const charts = system('charts', { description: 'Charts.', contributes: [{ registry: REGISTRY, name: 'broken', label: 'Broken' }] });

const one: ResultTable = { columns: [{ name: 'n', kind: 'integer', nullable: false }], rows: [[42]], offset: 0, truncated: false, sort: [] };
const many: ResultTable = { ...one, rows: [[1], [2]] };

function runtime(): ClientRuntime {
  const r = new ClientRuntime({
    online: () => true,
    act: () => Promise.resolve(mintId('delivery')),
    submit: () => Promise.resolve(mintId('delivery')),
    invoke: () => Promise.resolve(mintId('run')),
    follow: () => new Promise(() => undefined),
  });
  r.register(client(database, {
    visuals: {
      [REGISTRY]: {
        table: { match: () => ({ fits: true, score: TABLE_VISUAL_SCORE }), component: TableView },
        value: { match: (t) => (t.rows.length === 1 && t.columns.length === 1 ? { fits: true, score: 0.9 } : { fits: false, score: 0 }), component: ValueView },
      },
    },
  }));
  r.register(client(charts, { visuals: { [REGISTRY]: { broken: { match: () => { throw new Error('boom'); }, component: BrokenView } } } }));
  return r;
}

describe('visual registries', () => {
  it('lists the visuals that fit, best first and the table last', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = runtime();
    expect(r.visuals(REGISTRY, one).map((v) => `${v.system}/${v.name}`)).toEqual(['database/value', 'database/table']);
    expect(r.visuals(REGISTRY, many).map((v) => v.name)).toEqual(['table']);
    expect(r.visuals(REGISTRY, one)[0]?.props.table).toBe(one);
    expect(r.visuals('other/registry', one)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('client.visual.match-failed', expect.objectContaining({ system: 'charts', name: 'broken' }));
    warn.mockRestore();
  });

  it('refuses a visual the contract does not contribute', () => {
    expect(() => client(charts, { visuals: { [REGISTRY]: { pie: { match: () => ({ fits: true, score: 1 }), component: BrokenView } } } })).toThrow(/not in the contract's contributes/);
  });
});
