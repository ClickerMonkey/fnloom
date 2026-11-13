<script setup lang="ts">
/**
 * A result drawn by one of the visuals that can draw it: the best (product's ranking) unless the person picked
 * another, in one always-visible chrome row (product's tier 1): the page's own controls (`lead`), a family switcher
 * (hidden when only one fits), a style picker for the family (hidden when it has one style), the page's tools, a
 * menu with Copy CSV, Download CSV (the rows held), Download every row (when the page can stream the whole result) and,
 * for a chart, PNG and SVG, and full screen (the same view grown to the
 * screen, never remounted; Escape leaves). A click on a mark standing for a row emits `drill`; without a declared
 * drill (`drills`) it opens the row's actions instead. A chart's zoom or period emits `range`.
 */
import type { Json, ResultFacts, ResultTable } from '@harness/core';
import { computed, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import { UiIconButton, UiMenu, UiSegmented, UiSelect, copyText, type MenuItem, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { saveUrl } from '../visuals/export.ts';
import { usePalette } from '../visuals/palette.ts';
import DrawVisual from './DrawVisual.vue';
import { IMAGE_SLOT, type ImageExport } from '../visuals/size.ts';
import { csvFileName, toCsv, type ResultPager } from './table.ts';
import { chosenVisual, styleLabel, type RankedVisual, type RowOpener, type VisualChoice, type VisualRange } from './visuals.ts';

const props = withDefaults(defineProps<{
  table: ResultTable;
  title: string;
  /** The visuals that can draw it, best first. */
  visuals: readonly RankedVisual[];
  facts: ResultFacts;
  pager?: ResultPager | undefined;
  /** A button per row that opens what it offers. */
  opener?: RowOpener | undefined;
  /** A click on a row's mark runs the page's drill (else it opens the row's actions). */
  drills?: boolean;
  /** Download the whole result, not only the rows held (a widget's streamed export); absent where it can't. */
  exportAll?: (() => void) | undefined;
}>(), { pager: undefined, opener: undefined, drills: false, exportAll: undefined });
const chosen = defineModel<VisualChoice | undefined>('choice', { default: undefined });
const emit = defineEmits<{ copied: [ok: boolean]; drill: [row: number]; range: [range: VisualRange] }>();

const palette = usePalette();
const shown = computed(() => chosenVisual(props.visuals, chosen.value));
const families = computed<readonly SegmentOption<string>[]>(() => props.visuals.map((v) => ({ value: v.visual.name, label: v.visual.label, icon: v.visual.icon })));
const family = computed({ get: () => shown.value?.ranked.visual.name ?? '', set: (visual: string) => { chosen.value = { visual }; } });
const styles = computed<readonly SelectOption<string>[]>(() => {
  const ranked = shown.value?.ranked;
  return ranked === undefined ? [] : ranked.rank.styles.map((style) => ({ value: style, label: styleLabel(ranked.visual.shape, style) }));
});
const style = computed({ get: () => shown.value?.style ?? '', set: (picked: string) => { chosen.value = { visual: family.value, style: picked }; } });
/** The binding drawn: the ranking's default for the visual shown. */
const bind = computed(() => shown.value?.ranked.rank.bind ?? {});
/**
 * Everything the visual is drawn with, in one object (`DrawVisual` hands it over unmerged, so `style` stays a style name).
 */
const drawn = computed(() => ({
  ...shown.value?.ranked.visual.props, table: props.table, title: props.title, facts: props.facts, bind: bind.value, style: shown.value?.style ?? '',
  palette: palette.value, pager: props.pager, opener: props.opener, onDrill: drill, onRange: (range: VisualRange) => { emit('range', range); },
}));

const image = shallowRef<ImageExport | undefined>(undefined);
provide(IMAGE_SLOT, { set: (exporter) => { image.value = exporter; } });

type MenuValue = 'copy' | 'csv' | 'all' | 'png' | 'svg';
const menu = computed((): MenuItem<MenuValue>[] => [
  { value: 'copy', label: 'Copy as CSV', icon: 'copy' },
  { value: 'csv', label: props.exportAll === undefined ? 'Download CSV' : 'Download rows shown (CSV)', icon: 'download' },
  ...(props.exportAll === undefined ? [] : [{ value: 'all' as const, label: 'Download every row (CSV)', icon: 'download' as const }]),
  ...(image.value === undefined ? [] : [{ kind: 'separator' as const }, { value: 'png' as const, label: 'Download PNG', icon: 'image' as const }, { value: 'svg' as const, label: 'Download SVG', icon: 'image' as const }]),
]);

async function pick(value: MenuValue): Promise<void> {
  if (value === 'all') { props.exportAll?.(); return; }
  if (value === 'copy') { emit('copied', await copyText(toCsv(props.table, props.table.rows))); return; }
  const base = csvFileName(props.title).replace(/\.csv$/, '');
  if (value === 'csv') {
    const url = URL.createObjectURL(new Blob([toCsv(props.table, props.table.rows)], { type: 'text/csv;charset=utf-8' }));
    saveUrl(url, `${base}.csv`);
    URL.revokeObjectURL(url);
    return;
  }
  const exporter = image.value;
  if (exporter !== undefined) { saveUrl(exporter(value), `${base}.${value}`); }
}

function drill(row: number): void {
  if (props.drills) { emit('drill', row); return; }
  const cells: readonly Json[] | undefined = props.table.rows[row];
  if (cells !== undefined && props.opener?.has(cells) === true) { props.opener.open(cells); }
}

const full = ref(false);
function onKey(event: KeyboardEvent): void { if (event.key === 'Escape') { full.value = false; } }
watch(full, (on) => {
  if (on) { document.addEventListener('keydown', onKey); } else { document.removeEventListener('keydown', onKey); }
});
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); });
</script>

<template>
  <div class="result" :class="{ full }" data-testid="result-view" :data-visual="shown?.ranked.visual.name" :data-style="shown?.style" :role="full ? 'dialog' : undefined" :aria-label="full ? title : undefined">
    <div class="tools">
      <slot name="lead" />
      <!-- the families scroll sideways rather than wrap; the style and the actions stay together on one line -->
      <div v-if="visuals.length > 1" class="families"><UiSegmented v-model="family" :options="families" label="Show as" icon-only data-testid="result-visuals" /></div>
      <span class="actions">
        <UiSelect v-if="styles.length > 1" v-model="style" class="style" :options="styles" label="Style" hide-label size="sm" data-testid="result-style" />
        <slot name="tools" />
        <UiMenu :items="menu" label="Copy and download" @select="pick">
          <template #trigger="{ toggle, attrs }">
            <UiIconButton icon="download" label="Copy and download" size="sm" v-bind="attrs" data-testid="result-export" @click="toggle" />
          </template>
        </UiMenu>
        <UiIconButton :icon="full ? 'minimize' : 'maximize'" :label="full ? 'Leave full screen' : 'Full screen'" size="sm" data-testid="result-full" @click="full = !full" />
      </span>
    </div>
    <DrawVisual v-if="shown" :visual="shown.ranked.visual.component" :drawn="drawn" />
  </div>
</template>

<style scoped>
.result { display: grid; align-content: start; gap: var(--space-2); min-width: 0; }
.result.full {
  position: fixed; inset: 0; z-index: var(--z-dialog); overflow: auto; padding: var(--space-3) var(--space-4) var(--space-4);
  background: var(--surface); --chart-full: calc(100dvh - 120px);
}
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.families { flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.families::-webkit-scrollbar { display: none; }
.families :deep(.ui-segmented) { flex-wrap: nowrap; max-width: none; }
.style { flex: 0 1 auto; width: auto; min-width: 7rem; max-width: 12rem; margin-right: var(--space-1); }
.actions { display: flex; flex: 0 1 auto; align-items: center; gap: 2px; min-width: 0; margin-left: auto; }
</style>
