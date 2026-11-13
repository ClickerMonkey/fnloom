/**
 * A compiled sample for the authoring guide (**Visuals and widgets**): a system that adds its own ECharts chart to the
 * hub's visual registry, a bullet chart (each category's value against its target), declared with its shape and drawn
 * by its client with ECharts, which the system bundles itself. Nothing runs it; `npm run typecheck` compiles it.
 */
import { BarChart, ScatterChart, type BarSeriesOption, type ScatterSeriesOption } from 'echarts/charts';
import { DatasetComponent, GridComponent, TooltipComponent, type DatasetComponentOption, type GridComponentOption, type TooltipComponentOption } from 'echarts/components';
import { init, use, type ComposeOption, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { HUB_VISUALS, VISUAL_EMITS, channel, client, system, visual, visualTheme, type VisualView, type WithSystem } from '@harness/sdk';
import type { Json } from '@harness/core';

// #region visual
/** The contract: the bullet chart, declared in `hub/visuals` with the data it draws. */
export const charts = system('charts', {
  description: 'Charts for results.',
  contributes: [visual({
    name: 'bullet',
    label: 'Against target',
    icon: 'chart',
    shape: {
      channels: [
        channel('x', 'Category', ['text'], { role: 'group' }),
        channel('value', 'Value', ['integer', 'number'], { role: 'measure' }),
        channel('target', 'Target', ['integer', 'number'], { role: 'measure' }),
      ],
      // a phone-width axis holds a few dozen categories; past that the widget pages
      rows: { min: 1, max: 30 },
      whole: false,
      styles: [{ name: 'vertical', label: 'Vertical' }, { name: 'horizontal', label: 'Horizontal' }],
      // it binds three columns where bars bind two, so it ranks above them for data with a target
      priority: { band: 'encoded', terms: ['low-cardinality'] },
    },
  })],
});
// #endregion visual

// #region component
// register only what this chart uses, so the bundle stays small
use([BarChart, ScatterChart, DatasetComponent, GridComponent, TooltipComponent, CanvasRenderer]);

type Option = ComposeOption<BarSeriesOption | ScatterSeriesOption | DatasetComponentOption | GridComponentOption | TooltipComponentOption>;

/** A cell as ECharts reads one: numbers and text as they are, anything else as text. */
function cellOf(value: Json): string | number | null {
  return value === null || typeof value === 'number' || typeof value === 'string' ? value : JSON.stringify(value);
}

/** The bars and target marks of a view: the rows as a dataset, encoded by the bound columns. */
function optionOf(view: VisualView): Option {
  const [x = '', value = '', target = ''] = [view.bind['x']?.[0], view.bind['value']?.[0], view.bind['target']?.[0]];
  const across = view.style === 'horizontal';
  const category = { type: 'category' as const };
  const measure = { type: 'value' as const };
  return {
    dataset: { dimensions: view.table.columns.map((column) => column.name), source: view.table.rows.map((row) => row.map(cellOf)) },
    grid: { containLabel: true, left: 8, right: 8, top: 8, bottom: 8 },
    tooltip: { trigger: 'axis' },
    xAxis: across ? measure : category,
    yAxis: across ? category : measure,
    series: [
      { type: 'bar', name: value, encode: across ? { y: x, x: value } : { x, y: value } },
      { type: 'scatter', name: target, symbol: 'rect', symbolSize: across ? [3, 18] : [18, 3], encode: across ? { y: x, x: target } : { x, y: target } },
    ],
  };
}

/** The chart: ECharts in a div, themed from the palette, emitting `drill` with the clicked row. */
const BulletVisual = defineComponent((props: VisualView & WithSystem<(typeof charts)['defs']>, { emit }) => {
  const el = ref<HTMLDivElement>();
  let chart: EChartsType | undefined;
  const draw = (): void => {
    chart?.dispose();
    if (el.value === undefined) { return; }
    chart = init(el.value, visualTheme(props.palette));
    chart.on('click', (event) => { emit('drill', event.dataIndex); });
    chart.setOption(optionOf(props));
  };
  onMounted(draw);
  // a theme change brings a new palette: draw again with its colours
  watch(() => props.palette, draw);
  watch(() => [props.table, props.bind, props.style], () => chart?.setOption(optionOf(props), { notMerge: true }));
  onBeforeUnmount(() => chart?.dispose());
  return () => h('div', { ref: el, style: { width: '100%', height: '18rem' } });
  // eslint-disable-next-line vue/require-prop-types -- the setup function's signature types the props (Vue 3.3+)
}, { props: ['table', 'facts', 'bind', 'style', 'palette', 'system'], emits: VISUAL_EMITS });
// #endregion component

// #region client
/** The client: the chart's component. Its declared shape judges the fit; it has nothing to veto. */
export default client(charts, { visuals: { [HUB_VISUALS]: { bullet: { component: BulletVisual } } } });
// #endregion client
