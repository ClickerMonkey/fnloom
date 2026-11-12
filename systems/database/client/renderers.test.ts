/**
 * The query visuals and the result view: each visual's fit (the table always, lowest; a bar chart for a label and a
 * number over 2 to 50 rows; a value for one cell), and the result view showing the best one with a switch between
 * those that fit (none when only the table does), then the person's pick.
 */
import { TABLE_VISUAL_SCORE, mintId, type ResultTable, type RunId } from '@harness/core';
import { VISUALS, type SystemClient, type VisualSource } from '@harness/sdk';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { describe, expect, it } from 'vitest';
import type { DatabaseContract } from '../shared/index.ts';
import { barFit, tableFit, valueFit } from '../shared/visuals.ts';
import ResultView from './ResultView.vue';
import { OWN_VISUALS } from './own-visuals.ts';
import { fitting } from './visuals.ts';
import databaseClient from './index.ts';

const table = (columns: ResultTable['columns'], rows: ResultTable['rows']): ResultTable => ({ columns, rows, offset: 0, truncated: false, sort: [] });
const BY_STATUS = table([{ name: 'status', kind: 'text', nullable: false }, { name: 'total', kind: 'number', nullable: false }], [['open', 122], ['paid', 135.5], ['refunded', 7.25]]);
const ONE = table([{ name: 'revenue', kind: 'number', nullable: false }], [[1234.5]]);
const WIDE = table([{ name: 'id', kind: 'integer', nullable: false }, { name: 'name', kind: 'text', nullable: false }, { name: 'email', kind: 'text', nullable: true }], [[1, 'Ada', null]]);

const run = (): Promise<RunId> => Promise.resolve(mintId('run'));
const system: SystemClient<DatabaseContract['defs']> = {
  online: true, send: {},
  run: {
    at_instance: run, read_at_instance: run, author_query: run, pick_database: run, table_fns_available: run, table_fns_generate: run, change_schema: run, apply_type_changes: run, databases: run, tables: run, check_query: run, save_query: run, run_query: run,
    get_query: run, edit_query: run, create_table: run, alter_table: run,
  },
};

describe('query visuals', () => {
  it('fit by the shape of the result', () => {
    expect(tableFit()).toEqual({ fits: true, score: TABLE_VISUAL_SCORE });
    expect(barFit(BY_STATUS)).toEqual({ fits: true, score: 0.8 });
    expect(barFit(table(BY_STATUS.columns, [['open', 1]]))).toMatchObject({ fits: false });
    expect(barFit(table(BY_STATUS.columns, [['open', 'many'], ['paid', 2]]))).toMatchObject({ fits: false });
    expect(barFit(WIDE)).toMatchObject({ fits: false });
    expect(valueFit(ONE)).toEqual({ fits: true, score: 0.9 });
    expect(fitting(BY_STATUS, OWN_VISUALS).map((visual) => visual.name)).toEqual(['bar', 'table']);
    expect(fitting(WIDE, OWN_VISUALS).map((visual) => visual.name)).toEqual(['table']);
  });
});

describe('ResultView', () => {
  it('shows the best fitting visual, and switches to another the person picks', async () => {
    const view = mount(ResultView, { props: { data: BY_STATUS, title: 'database/main.totals', system } });
    expect(view.find('.db-bars').exists()).toBe(true);
    expect(view.findAll('[role="radio"]').map((button) => button.text())).toEqual(['Bar chart', 'Table']);
    expect(view.text()).toContain('3 rows');
    await view.findAll('[role="radio"]')[1]?.trigger('click');
    expect(view.find('.db-table').exists()).toBe(true);
    expect(view.findAll('tbody tr')).toHaveLength(3);
    expect(view.find('[aria-checked="true"]').text()).toBe('Table');
  });

  it('draws one value large, and a plain table with no switch when nothing else fits', () => {
    expect(mount(ResultView, { props: { data: ONE, title: 'x', system } }).find('.db-value .number').text()).toContain('1');
    const wide = mount(ResultView, { props: { data: { ...WIDE, total: 40, truncated: true, limit: 1 }, title: 'x', system } });
    expect(wide.find('[role="radiogroup"]').exists()).toBe(false);
    expect(wide.find('td.empty').text()).toBe('—');
    expect(wide.text()).toContain('Rows 1–1 of 40');
  });

  it('offers the visuals every loaded system contributes when the chat gives them', () => {
    const pie = (props: { table: ResultTable }) => h('figure', { class: 'pie' }, String(props.table.rows.length));
    const grid = () => h('table');
    const source: VisualSource = {
      visuals: (_registry, data) => [
        { system: 'charts', name: 'pie', label: 'Pie chart', fit: { fits: true, score: 0.95 }, component: pie, props: { table: data, system } },
        { system: 'database', name: 'table', label: 'Table', fit: tableFit(), component: grid, props: { table: data, system } },
      ],
    };
    const view = mount(ResultView, { props: { data: BY_STATUS, title: 'x', system }, global: { provide: { [VISUALS]: source } } });
    expect(view.find('figure.pie').text()).toBe('3');
    expect(view.findAll('[role="radio"]').map((button) => button.text())).toEqual(['Pie chart', 'Table']);
  });
});

describe('the client module', () => {
  it('loads: every visual it registers is in the contributes list', () => {
    const listed = databaseClient.contract.contributes.map((c) => `${c.registry} ${c.name}`);
    expect(listed).toEqual(Object.keys(OWN_VISUALS).map((name) => `database/query-visuals ${name}`));
  });
});
