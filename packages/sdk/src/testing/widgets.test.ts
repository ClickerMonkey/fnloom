/**
 * The kit's widget support: the fake hub answers `hub/read_table`, `hub/visuals` and `hub/row_actions` as the hub does,
 * and `kit.visuals(table)` ranks a system's own visual among the built-in ones.
 */
import { HUB_VISUALS, type ResultTable } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g, wireType } from '../gin.ts';
import { system, type SystemImpl } from '../system.ts';
import { channel, visual } from '../widgets.ts';
import { FakeHubWidgets, HUB_WIDGET_FNS, testHub } from './index.ts';

const TABLE: ResultTable = {
  columns: [{ name: 'stage', kind: 'text', nullable: false }, { name: 'count', kind: 'integer', nullable: false }],
  rows: [['todo', 4], ['doing', 2], ['done', 9]],
  offset: 0, truncated: false, sort: [],
};

describe('the fake hub\'s widget fns', () => {
  it('reads registered tables, lists the visuals and derives row actions', () => {
    const widgets = new FakeHubWidgets();
    widgets.table('tasks/by_stage', (args) => ({ ...TABLE, rows: TABLE.rows.slice(0, typeof args['limit'] === 'number' ? args['limit'] : undefined) }));
    widgets.rowFns('tasks/Task', [{ fn: 'tasks/Task.close', mode: 'write', args: wireType(g.obj({ self: g.text() })), returnsTable: false }]);
    expect(widgets.settle({ fn: HUB_WIDGET_FNS.readTable, args: { fn: 'tasks/by_stage', args: { limit: 2 } } })).toMatchObject({ status: 'done', result: { rows: [['todo', 4], ['doing', 2]] } });
    const refused = widgets.settle({ fn: HUB_WIDGET_FNS.readTable, args: { fn: 'tasks/delete_all', args: {} } });
    expect(refused?.status === 'failed' ? refused.error.message : '').toMatch(/not a read fn/);
    expect(widgets.reads.map((read) => read.fn)).toEqual(['tasks/by_stage', 'tasks/delete_all']);
    const visuals = widgets.settle({ fn: HUB_WIDGET_FNS.visuals, args: null });
    expect(visuals?.status === 'done' && Array.isArray(visuals.result) ? visuals.result.length : 0).toBe(13);
    expect(widgets.settle({ fn: HUB_WIDGET_FNS.rowActions, args: { types: ['tasks/Task'] } })).toEqual({
      status: 'done', result: [{ fn: 'tasks/Task.close', label: 'Close', mode: 'write', confirm: true, bind: {}, then: 'refresh' }],
    });
    expect(widgets.settle({ fn: 'hub/other', args: {} })).toBeUndefined();
  });

  it('ranks a system\'s own visual among the built-in ones', async () => {
    const charts = system('charts', {
      description: 'Charts.',
      contributes: [visual({ name: 'waffle', label: 'Waffle', shape: { channels: [channel('itemName', 'Square', ['text'], { role: 'group' }), channel('value', 'Size', ['integer'], { role: 'measure' })], rows: { min: 1, max: 10 }, whole: true, priority: { band: 'time-encoded', terms: ['low-cardinality'] } } })],
    }).with({ fns: { ping: fn({ description: 'Ping.', args: g.obj({}), returns: g.text() }) } });
    const impl: SystemImpl<(typeof charts)['defs']> = { fns: { ping: { async run(_args, ctx) { return ctx.done('pong'); } } } };
    const kit = await testHub(charts, impl);
    try {
      const [best] = kit.visuals(TABLE);
      expect(best).toMatchObject({ visual: 'waffle', bind: { itemName: ['stage'], value: ['count'] } });
      expect(kit.visuals(TABLE).map((rank) => rank.visual)).toContain('table');
      expect(charts.contributes[0]?.registry).toBe(HUB_VISUALS);
    } finally {
      await kit.stop();
    }
  });
});
