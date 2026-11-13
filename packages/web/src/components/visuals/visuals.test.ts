import { BUILT_IN_ENTRIES, BUILT_IN_VISUALS, columnFacts, rankVisuals, type ResultColumn, type ResultTable, type VisualFamily } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import ChartVisual from './ChartVisual.vue';
import { isChartFamily, type ChartFamily } from './families/index.ts';
import { CHART_SAMPLES as SAMPLES } from './test/samples.ts';
import { hasCycle } from './families/network.ts';
import { rings, sized, treeOf } from './families/hierarchy.ts';
import { packLanes } from './families/timeline.ts';
import { periodOf } from './families/calendar.ts';
import { foldSlices, histogram, OTHER_SLICE } from './maths.ts';
import { chartColor, LIGHT_PALETTE } from './palette.ts';
import ValueVisual from './ValueVisual.vue';
import VChart from 'vue-echarts';

// ECharts draws into a canvas or SVG a test DOM can't lay out; the stub keeps the option it is given and the events.
vi.mock('vue-echarts', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'VChart',
      props: { option: { type: Object, required: true }, theme: { type: Object, default: undefined }, initOptions: { type: Object, default: undefined }, autoresize: Boolean },
      emits: ['click', 'datazoom'],
      setup(_props, { expose }) {
        expose({ getOption: () => ({ dataZoom: [{ startValue: Date.UTC(2026, 0, 2), endValue: Date.UTC(2026, 0, 4) }] }) });
        return () => h('div', { 'data-testid': 'echarts' });
      },
    }),
  };
});

afterEach(() => { vi.useRealTimers(); });

const col = (name: string, kind: ResultColumn['kind']): ResultColumn => ({ name, kind, nullable: true });
const tableOf = (columns: ResultColumn[], rows: ResultTable['rows']): ResultTable => ({ columns, rows, offset: 0, truncated: false, sort: [] });

/** The ECharts series each style draws, in order. */
const SERIES: Readonly<Record<ChartFamily, Readonly<Record<string, readonly string[]>>>> = {
  part: { pie: ['pie'], doughnut: ['pie'], rose: ['pie'], half: ['pie'], funnel: ['funnel'] },
  category: { bar: ['bar', 'bar'], stacked: ['bar', 'bar'], percent: ['bar', 'bar'], horizontal: ['bar', 'bar'], line: ['line', 'line'], area: ['line', 'line'], radar: ['radar'], polar: ['bar', 'bar'], pictorial: ['pictorialBar', 'pictorialBar'] },
  time: { line: ['line', 'line'], smooth: ['line', 'line'], area: ['line', 'line'], stacked: ['line', 'line'], step: ['line', 'line'], bar: ['bar', 'bar'], river: ['themeRiver'] },
  distribution: { scatter: ['scatter', 'scatter'], bubble: ['scatter', 'scatter'], pulse: ['effectScatter', 'effectScatter'], histogram: ['bar'], boxplot: ['boxplot', 'scatter'], parallel: ['parallel', 'parallel'] },
  crosstab: { heatmap: ['heatmap'], cells: ['heatmap'], multiples: ['bar', 'bar'] },
  calendar: { month: ['heatmap'], year: ['heatmap'] },
  timeline: { gantt: ['custom'], timeline: ['custom'] },
  network: { force: ['graph'], circular: ['graph'], sankey: ['sankey'], chord: ['chord'] },
  hierarchy: { tree: ['tree'], radial: ['tree'], treemap: ['treemap'], sunburst: ['sunburst'] },
  gauge: { gauge: ['gauge'], progress: ['gauge'] },
  finance: { candlestick: ['candlestick'], volume: ['candlestick', 'bar'] },
};

const Drawn = z.object({ series: z.array(z.object({ type: z.string() })) });

function rankOf(family: VisualFamily, table: ResultTable): ReturnType<typeof rankVisuals>[number] | undefined {
  return rankVisuals(BUILT_IN_ENTRIES, columnFacts(table), table).find((rank) => rank.visual === family);
}

function draw(family: ChartFamily, style: string, table = SAMPLES[family]): ReturnType<typeof mount<typeof ChartVisual>> {
  const rank = rankOf(family, table);
  if (rank === undefined) { throw new Error(`${family} does not rank.`); }
  return mount(ChartVisual, { props: { family, style, table, title: family, facts: columnFacts(table), bind: rank.bind, palette: LIGHT_PALETTE } });
}

function seriesTypes(wrapper: ReturnType<typeof draw>): string[] {
  return Drawn.parse(wrapper.getComponent(VChart).props('option')).series.map((s) => s.type);
}

describe('chart families', () => {
  for (const family of Object.keys(SERIES).filter(isChartFamily)) {
    it(`${family}: offers every style over a whole result and draws each with its ECharts series`, () => {
      const rank = rankOf(family, SAMPLES[family]);
      expect(rank?.styles).toEqual(BUILT_IN_VISUALS[family].shape.styles.map((s) => s.name));
      for (const [style, types] of Object.entries(SERIES[family])) {
        expect([style, seriesTypes(draw(family, style))]).toEqual([style, types]);
      }
    });
  }

  it('hides whole-result styles and visuals over one page of a result', () => {
    const page = { ...SAMPLES.distribution, truncated: true };
    expect(rankOf('distribution', page)?.styles).not.toContain('histogram');
    expect(rankOf('part', { ...SAMPLES.part, truncated: true })).toBeUndefined();
  });

  it('drills into the row a mark stands for, and not for a mark that stands for many', async () => {
    const bars = draw('category', 'bar');
    bars.getComponent(VChart).vm.$emit('click', { seriesIndex: 0, dataIndex: 2 });
    expect(bars.emitted('drill')).toEqual([[2]]);
    const flow = draw('network', 'force');
    flow.getComponent(VChart).vm.$emit('click', { dataType: 'node', dataIndex: 0 });
    flow.getComponent(VChart).vm.$emit('click', { dataType: 'edge', dataIndex: 1 });
    expect(flow.emitted('drill')).toEqual([[1]]);
    await flushPromises();
  });

  it('sets the range from a zoomed time axis, debounced, as days', () => {
    vi.useFakeTimers();
    const chart = draw('time', 'line');
    chart.getComponent(VChart).vm.$emit('datazoom', {});
    chart.getComponent(VChart).vm.$emit('datazoom', {});
    vi.runAllTimers();
    expect(chart.emitted('range')).toEqual([[{ from: '2026-01-02', to: '2026-01-04' }]]);
  });

  it('pages a calendar by month from the latest, setting the range to the month shown', async () => {
    const chart = draw('calendar', 'month');
    expect(chart.get('[data-testid=chart-period]').text()).toContain('2026');
    await chart.get('[data-testid=chart-period-earlier]').trigger('click');
    expect(chart.emitted('range')).toEqual([[{ from: '2026-01-01', to: '2026-01-31' }]]);
    expect(periodOf('2026-03-15', true, 1)).toMatchObject({ range: '2025', from: '2025-01-01', to: '2025-12-31' });
  });

  it('says why a flow can’t draw links that loop, and picks canvas for many marks', () => {
    const loop = tableOf([col('from', 'text'), col('to', 'text')], [['a', 'b'], ['b', 'a']]);
    expect(draw('network', 'sankey', loop).get('[data-testid=chart-problem]').text()).toContain('loop');
    expect(hasCycle([{ source: 'a', target: 'b' }])).toBe(false);
    const many = tableOf([col('x', 'number'), col('y', 'number')], Array.from({ length: 2500 }, (_, i) => [i, i % 7]));
    expect(draw('distribution', 'scatter', many).get('[data-testid=chart-visual]').attributes('data-renderer')).toBe('canvas');
  });
});

describe('the value family', () => {
  it('shows each bound value as a card, or the first large, and drills into its row', async () => {
    const table = tableOf([col('open', 'integer'), col('done', 'integer')], [[4, 9]]);
    const rank = rankOf('value', table);
    const props = { table, title: 'Tasks', facts: columnFacts(table), bind: rank?.bind ?? {}, palette: LIGHT_PALETTE };
    const cards = mount(ValueVisual, { props: { ...props, style: 'cards' } });
    expect(cards.findAll('[data-testid=value-card]').map((c) => c.text())).toEqual(['open4', 'done9']);
    await cards.get('[data-testid=value-card]').trigger('click');
    expect(cards.emitted('drill')).toEqual([[0]]);
    const single = mount(ValueVisual, { props: { ...props, style: 'single' } });
    expect(single.get('.big').text()).toBe('open4');
  });
});

describe('browser maths and colour', () => {
  it('bins numbers on round edges, folds small slices into Other, and builds a tree from parents', () => {
    const bins = histogram([1, 2, 2, 3, 9]);
    expect(bins.reduce((n, b) => n + b.count, 0)).toBe(5);
    expect(bins[0]?.from).toBe(0);
    expect(histogram([4, 4])).toEqual([{ from: 4, to: 4, count: 2 }]);
    const slices = Array.from({ length: 25 }, (_, i) => ({ name: `s${String(i)}`, value: i + 1, row: i }));
    const folded = foldSlices(slices);
    expect(folded).toHaveLength(20);
    expect(folded.at(-1)).toEqual({ name: OTHER_SLICE, value: 21, row: undefined });
    const roots = treeOf([{ name: 'a', parent: null, value: null }, { name: 'b', parent: 'a', value: 2 }, { name: 'c', parent: 'c', value: 1 }]);
    expect(roots.map((r) => [r.name, r.children.length])).toEqual([['a', 1], ['c', 0]]);
  });

  it('sizes a sunburst so branches hold their children and rings start below one root', () => {
    const tree = sized(treeOf([{ name: 'All', parent: null, value: 0 }, { name: 'Docs', parent: 'All', value: 3 }, { name: 'Code', parent: 'All', value: 5 }, { name: 'Tests', parent: 'Code', value: 2 }, { name: 'Lib', parent: 'Code', value: 4 }]));
    expect(tree[0]?.value).toBe(9);
    expect(rings(tree).map((node) => [node.name, node.value])).toEqual([['Docs', 3], ['Code', 6]]);
    expect(rings([{ name: 'a', row: 0, children: [] }, { name: 'b', row: 1, children: [] }]).map((node) => node.name)).toEqual(['a', 'b']);
  });

  it('packs timeline items into as few lanes as fit without overlap', () => {
    expect(packLanes([{ start: 0, end: 5 }, { start: 4, end: 9 }, { start: 6, end: 8 }, { start: null, end: 3 }])).toEqual([0, 1, 0, 0]);
  });

  it('turns the tokens’ OKLCH colours into hex ECharts reads, keeping anything else', () => {
    expect(chartColor('oklch(0.55 0.17 268)')).toMatch(/^#[0-9a-f]{6}$/);
    expect(chartColor('oklch(1 0 0)')).toBe('#ffffff');
    expect(chartColor('oklch(0 0 0 / 0.5)')).toBe('#00000080');
    expect(chartColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
  });
});
