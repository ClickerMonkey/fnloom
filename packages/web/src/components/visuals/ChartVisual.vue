<script setup lang="ts">
/**
 * A chart family drawn with ECharts (vue-echarts): the family's option from the table, binding and style, the
 * palette's theme (set again on a theme change, no remount), SVG under `SVG_MAX_POINTS` marks and canvas above,
 * coarse-pointer hit testing, and a resize with its frame. A click on a mark that stands for one row emits `drill`
 * (where nothing opens from a mark, no drill and no row menu, the marks don't point);
 * a zoom of a range axis, or a calendar's period, emits `range` (debounced). While mounted it offers PNG and SVG
 * export to the result view around it. A family that can't lay this data out says why instead.
 */
import { z } from 'zod';
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import VChart from 'vue-echarts';
import { UiIconButton, useMediaQuery } from '../../ui/index.ts';
import { DRILLABLE, type VisualProps, type VisualRange } from '../results/visuals.ts';
import { isoOf, type ChartClick, type ChartDraw, type RangeAxis } from './chart-data.ts';
import { chartTheme } from './echarts-setup.ts';
import { chartImage } from './export.ts';
import { CHART_BUILDERS, type ChartFamily } from './families/index.ts';
import { IMAGE_SLOT, PHONE_WIDTH, useWidth } from './size.ts';

/** Above this many marks a chart draws on canvas; below it in SVG (crisper text, prints cleanly). */
const SVG_MAX_POINTS = 2000;
/** The usual chart height, in pixels. */
const CHART_HEIGHT = 320;
/** How long a zoom rests before it sets the range. */
const RANGE_DEBOUNCE_MS = 400;

const props = defineProps<VisualProps & { family: ChartFamily }>();
const emit = defineEmits<{ drill: [row: number]; range: [range: VisualRange] }>();

const frame = ref<HTMLElement | null>(null);
const width = useWidth(frame);
const phone = computed(() => width.value > 0 && width.value < PHONE_WIDTH);
/** Periods back from the latest (the calendar). */
const shift = ref(0);
watch(() => [props.table, props.style] as const, () => { shift.value = 0; });

const built = computed(() => CHART_BUILDERS[props.family]({
  table: props.table, facts: props.facts, bind: props.bind, style: props.style, palette: props.palette, phone: phone.value, shift: shift.value,
}));
const draw = computed((): ChartDraw | undefined => ('problem' in built.value ? undefined : built.value));
const problem = computed(() => ('problem' in built.value ? built.value.problem : undefined));
const theme = computed(() => chartTheme(props.palette));
/** Charts draw at once, without their entry animation, for a person who asks for reduced motion (and for screenshots). */
const still = useMediaQuery('(prefers-reduced-motion: reduce)');

/** Whether a mark opens anything (a drill, or the row's menu): if not, the marks don't point. */
const drillable = inject(DRILLABLE, undefined);
const clickable = computed(() => drillable === undefined || drillable.value || props.opener !== undefined);
/** The option drawn: without the entry animation when asked, and with marks that don't point when they open nothing. */
const option = computed(() => {
  const shown = draw.value?.option;
  if (shown === undefined) { return undefined; }
  const base = still.value ? { ...shown, animation: false } : shown;
  if (clickable.value) { return base; }
  const series = base.series;
  return { ...base, series: (Array.isArray(series) ? series : series === undefined ? [] : [series]).map((one: object) => ({ ...one, cursor: 'default' })) };
});

const renderer = computed((): 'canvas' | 'svg' => ((draw.value?.points ?? 0) > SVG_MAX_POINTS ? 'canvas' : 'svg'));
const initOptions = computed(() => ({ renderer: renderer.value, useCoarsePointer: true, pointerSize: 24 }));
const height = computed(() => `${String(draw.value?.height ?? CHART_HEIGHT)}px`);

function onClick(event: ChartClick): void {
  const row = draw.value?.rowOf?.(event);
  if (row !== undefined && row >= 0) { emit('drill', row); }
}

const chart = ref<InstanceType<typeof VChart> | null>(null);
const ZoomState = z.object({ dataZoom: z.array(z.object({ startValue: z.union([z.number(), z.string()]).optional(), endValue: z.union([z.number(), z.string()]).optional() })).optional() });
let resting: ReturnType<typeof setTimeout> | undefined;

/** A zoom end as the range's value: an ISO day or instant on a time axis, the category's value on a category axis. */
function rangeValue(axis: RangeAxis, value: number | string | undefined): string | undefined {
  if (value === undefined) { return undefined; }
  if (axis.kind === 'time') { return typeof value === 'number' ? isoOf(value, axis.day) : value; }
  const at = typeof value === 'number' ? axis.values[value] : value;
  return at === undefined || at === null ? undefined : String(at);
}

function onZoom(): void {
  const axis = draw.value?.range;
  if (axis === undefined) { return; }
  clearTimeout(resting);
  resting = setTimeout(() => {
    const state = ZoomState.safeParse(chart.value?.getOption());
    const [zoomed] = state.success ? state.data.dataZoom ?? [] : [];
    const from = rangeValue(axis, zoomed?.startValue); const to = rangeValue(axis, zoomed?.endValue);
    if (from !== undefined && to !== undefined) { emit('range', { from, to }); }
  }, RANGE_DEBOUNCE_MS);
}

function moveBy(step: number): void {
  shift.value = Math.max(0, shift.value + step);
  const period = draw.value?.period;
  if (period !== undefined) { emit('range', { from: period.from, to: period.to }); }
}

const slot = inject(IMAGE_SLOT, undefined);
watch(draw, (shown) => {
  slot?.set(shown === undefined ? undefined : (kind) => chartImage({
    option: shown.option, theme: theme.value, width: frame.value?.clientWidth ?? PHONE_WIDTH, height: draw.value?.height ?? CHART_HEIGHT, background: props.palette.surface,
  }, kind));
}, { immediate: true });
onBeforeUnmount(() => { clearTimeout(resting); slot?.set(undefined); });
</script>

<template>
  <div ref="frame" class="chart" data-testid="chart-visual" :data-family="family" :data-style="style" :data-renderer="renderer" :style="{ '--chart-h': height }">
    <div v-if="draw?.period" class="period" data-testid="chart-period">
      <UiIconButton icon="chevron-left" label="Earlier" size="sm" :disabled="!draw.period.before" data-testid="chart-period-earlier" @click="moveBy(1)" />
      <span class="label">{{ draw.period.label }}</span>
      <UiIconButton icon="chevron-right" label="Later" size="sm" :disabled="shift === 0" data-testid="chart-period-later" @click="moveBy(-1)" />
    </div>
    <p v-if="problem" class="problem" data-testid="chart-problem">{{ problem }}</p>
    <VChart
      v-else-if="draw" :key="renderer" ref="chart" class="canvas" :option="option ?? draw.option" :theme="theme" :init-options="initOptions" autoresize
      :aria-label="title" @click="onClick" @datazoom="onZoom"
    />
  </div>
</template>

<style scoped>
.chart { display: grid; gap: var(--space-1); width: 100%; min-width: 0; }
.canvas { width: 100%; min-width: 0; height: var(--chart-full, var(--chart-h)); }
.period { display: flex; align-items: center; justify-content: center; gap: var(--space-2); }
.period .label { min-width: 10ch; color: var(--text); font-size: var(--text-sm); font-weight: var(--weight-medium); text-align: center; }
.problem { margin: 0; padding: var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-size: var(--text-sm); }
</style>
