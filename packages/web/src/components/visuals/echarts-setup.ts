/**
 * ECharts, tree-shaken: only the charts, components and renderers the built-in families draw, registered once with
 * `echarts/core`. Imported only by the chart component and the image export, which load on the first chart drawn, so
 * the chat bundle carries none of it until then. Also the option type every family builds and the theme object a
 * palette becomes.
 */
import {
  BarChart, BoxplotChart, CandlestickChart, ChordChart, CustomChart, EffectScatterChart, FunnelChart, GaugeChart, GraphChart, HeatmapChart, LineChart,
  ParallelChart, PictorialBarChart, PieChart, RadarChart, SankeyChart, ScatterChart, SunburstChart, ThemeRiverChart, TreeChart, TreemapChart,
} from 'echarts/charts';
import {
  AriaComponent, CalendarComponent, DataZoomComponent, DatasetComponent, GridComponent, LegendComponent, MatrixComponent, ParallelComponent, PolarComponent,
  RadarComponent, SingleAxisComponent, TitleComponent, TooltipComponent, TransformComponent, VisualMapComponent,
} from 'echarts/components';
import type { EChartsOption } from 'echarts';
import { use } from 'echarts/core';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import type { ChartPalette } from './palette.ts';

use([
  BarChart, BoxplotChart, CandlestickChart, ChordChart, CustomChart, EffectScatterChart, FunnelChart, GaugeChart, GraphChart, HeatmapChart, LineChart,
  ParallelChart, PictorialBarChart, PieChart, RadarChart, SankeyChart, ScatterChart, SunburstChart, ThemeRiverChart, TreeChart, TreemapChart,
  AriaComponent, CalendarComponent, DataZoomComponent, DatasetComponent, GridComponent, LegendComponent, MatrixComponent, ParallelComponent, PolarComponent,
  RadarComponent, SingleAxisComponent, TitleComponent, TooltipComponent, TransformComponent, VisualMapComponent,
  CanvasRenderer, SVGRenderer,
]);

/**
 * Every option a built-in family draws. Typed as ECharts' full option (a type only: it costs nothing in the bundle), since
 * `ComposeOption`'s dependency index signature rejects exact optional props; the `use` list above is what is drawable.
 */
export type ChartOption = EChartsOption;

/** An ECharts theme object: the parts of a theme a palette sets (passed to `setTheme`, never registered by name). */
export interface ChartTheme {
  readonly color: readonly string[];
  readonly backgroundColor: string;
  readonly textStyle: { readonly color: string; readonly fontFamily: string };
  readonly [part: string]: unknown;
}

/** The axis look every cartesian, polar and single axis shares. */
function axis(palette: ChartPalette): Readonly<Record<string, unknown>> {
  return {
    axisLine: { lineStyle: { color: palette.grid } }, axisTick: { lineStyle: { color: palette.grid } },
    // labels that would run into each other are left out (a day axis on a phone)
    axisLabel: { color: palette.muted, hideOverlap: true }, splitLine: { lineStyle: { color: palette.grid } }, nameTextStyle: { color: palette.muted },
  };
}

/** The ECharts theme of a palette: series colours, text, axes, legend, tooltip and zoom in the theme's colours. */
export function chartTheme(palette: ChartPalette): ChartTheme {
  const axes = axis(palette);
  return {
    color: palette.series,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: palette.font },
    title: { textStyle: { color: palette.text }, subtextStyle: { color: palette.muted } },
    legend: { textStyle: { color: palette.muted }, pageTextStyle: { color: palette.muted }, pageIconColor: palette.text, pageIconInactiveColor: palette.grid },
    tooltip: { backgroundColor: palette.surface, borderColor: palette.grid, textStyle: { color: palette.text } },
    categoryAxis: axes, valueAxis: axes, timeAxis: axes, logAxis: axes,
    radar: { axisName: { color: palette.muted }, axisLine: { lineStyle: { color: palette.grid } }, splitLine: { lineStyle: { color: palette.grid } }, splitArea: { show: false } },
    dataZoom: { textStyle: { color: palette.muted }, borderColor: palette.grid, fillerColor: `${palette.series[0] ?? palette.text}22`, handleStyle: { color: palette.surface, borderColor: palette.muted } },
    visualMap: { textStyle: { color: palette.muted } },
    calendar: { dayLabel: { color: palette.muted }, monthLabel: { color: palette.muted }, yearLabel: { color: palette.muted }, itemStyle: { color: palette.surface, borderColor: palette.grid }, splitLine: { lineStyle: { color: palette.grid } } },
    candlestick: { itemStyle: { color: palette.up, color0: palette.down, borderColor: palette.up, borderColor0: palette.down } },
    graph: { lineStyle: { color: palette.grid }, label: { color: palette.text } },
  };
}
