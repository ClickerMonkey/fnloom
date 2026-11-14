<script setup lang="ts">
/**
 * A result drawn by one of the visuals that can draw it: the best (product's ranking) unless the person picked
 * another. Its chrome shows only what says what data this is (build-9 feedback, widget chrome): the page's context
 * (`context`: a widget's title and chips; `lead`: the Data page's search and filters), the visual toggle when the page
 * offers a chosen few (`toggle`: a widget's own visuals), and the page's state that needs a person (`tools`: staged
 * edits, Live). Everything else is in the 3-dot menu at the top right, shown while the view is hovered or holds focus
 * (and always, faintly, on a touch screen): Export image (PNG, SVG; a chart only), Export CSV (the rows held, and every
 * row when the page can stream the whole result), Export JSON, Copy as CSV, the page's own items (`items`: Refresh,
 * Make a widget), Full screen (the same view grown to the screen, never remounted; Escape or its close button leaves)
 * and Settings (the visual and its style; the page adds its Save, `settings`). A click on a mark standing for a row
 * emits `drill`; without a declared drill (`drills`) it opens the row's actions instead. A chart's zoom or period
 * emits `range`.
 */
import type { Json, ResultFacts, ResultTable } from '@harness/core';
import { computed, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import { UiButton, UiDialog, UiIconButton, UiMenu, UiSegmented, UiSelect, copyText, type MenuAction, type MenuItem, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { saveUrl } from '../visuals/export.ts';
import { usePalette } from '../visuals/palette.ts';
import DrawVisual from './DrawVisual.vue';
import { IMAGE_SLOT, type ImageExport } from '../visuals/size.ts';
import { csvFileName, toCsv, toJson, type ResultPager } from './table.ts';
import { chosenVisual, styleLabel, type RankedVisual, type RowOpener, type VisualChoice, type VisualRange } from './visuals.ts';

const props = withDefaults(defineProps<{
  table: ResultTable;
  title: string;
  /** The visuals offered, best first (a widget's own, in its order). */
  visuals: readonly RankedVisual[];
  /** Other visuals that can draw it, offered only in Settings (beside a widget's own). */
  others?: readonly RankedVisual[];
  /** Show the offered visuals as a toggle in the chrome (a widget's chosen few); otherwise they are in Settings only. */
  toggle?: boolean;
  facts: ResultFacts;
  pager?: ResultPager | undefined;
  /** A button per row that opens what it offers. */
  opener?: RowOpener | undefined;
  /** A click on a row's mark runs the page's drill (else it opens the row's actions). */
  drills?: boolean;
  /** Download the whole result, not only the rows held (a widget's streamed export); absent where it can't. */
  exportAll?: (() => void) | undefined;
  /** The page's own menu items (Refresh, Run again, Make a widget), between the exports and Full screen. */
  items?: readonly MenuAction<string>[];
}>(), { others: () => [], toggle: false, pager: undefined, opener: undefined, drills: false, exportAll: undefined, items: () => [] });
const chosen = defineModel<VisualChoice | undefined>('choice', { default: undefined });
const emit = defineEmits<{ copied: [ok: boolean]; drill: [row: number]; range: [range: VisualRange]; item: [value: string] }>();
const slots = defineSlots<{ context?: () => unknown; lead?: () => unknown; tools?: () => unknown; settings?: (props: { close: () => void }) => unknown }>();

const palette = usePalette();
const every = computed(() => [...props.visuals, ...props.others.filter((o) => !props.visuals.some((v) => v.visual.name === o.visual.name))]);
const shown = computed(() => chosenVisual(every.value, chosen.value));
const optionOf = (v: RankedVisual): SegmentOption<string> => ({ value: v.visual.name, label: v.visual.label, icon: v.visual.icon });
const families = computed<readonly SegmentOption<string>[]>(() => props.visuals.map(optionOf));
const allFamilies = computed<readonly SegmentOption<string>[]>(() => every.value.map(optionOf));
const family = computed({ get: () => shown.value?.ranked.visual.name ?? '', set: (visual: string) => { chosen.value = { visual }; } });
const styles = computed<readonly SelectOption<string>[]>(() => {
  const ranked = shown.value?.ranked;
  return ranked === undefined ? [] : ranked.rank.styles.map((style) => ({ value: style, label: styleLabel(ranked.visual.shape, style) }));
});
const style = computed({ get: () => shown.value?.style ?? '', set: (picked: string) => { chosen.value = { visual: family.value, style: picked }; } });
/** The toggle shows only a chosen few, and only when there is more than one. */
const toggled = computed(() => props.toggle && props.visuals.length > 1);
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

const full = ref(false);
const settingsOpen = ref(false);
const OWN = ['png', 'svg', 'csv', 'all', 'json', 'copy', 'full', 'settings'] as const;
type Own = (typeof OWN)[number];
const OWN_VALUES: ReadonlySet<string> = new Set(OWN);
const isOwn = (value: string): value is Own => OWN_VALUES.has(value);
/** The menu: exports (an image only where the visual draws one), the page's items, then full screen and Settings. */
const menu = computed((): MenuItem<string>[] => {
  const none = props.table.columns.length === 0;
  return [
    { value: 'png', label: 'Export image (PNG)', icon: 'image', disabled: image.value === undefined },
    ...(image.value === undefined ? [] : [{ value: 'svg', label: 'Export image (SVG)', icon: 'image' as const }]),
    { value: 'csv', label: props.exportAll === undefined ? 'Export CSV' : 'Export CSV (rows shown)', icon: 'download', disabled: none },
    ...(props.exportAll === undefined ? [] : [{ value: 'all', label: 'Export CSV (every row)', icon: 'download' as const }]),
    { value: 'json', label: 'Export JSON', icon: 'braces', disabled: none },
    { value: 'copy', label: 'Copy as CSV', icon: 'copy', disabled: none },
    ...(props.items.length === 0 ? [] : [{ kind: 'separator' as const }, ...props.items]),
    { kind: 'separator' },
    full.value ? { value: 'full', label: 'Leave full screen', icon: 'minimize' } : { value: 'full', label: 'Full screen', icon: 'maximize' },
    { value: 'settings', label: 'Settings', icon: 'settings' },
  ];
});

function save(text: string, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  saveUrl(url, name);
  URL.revokeObjectURL(url);
}

async function pick(value: string): Promise<void> {
  if (!isOwn(value)) { emit('item', value); return; }
  const base = csvFileName(props.title).replace(/\.csv$/, '');
  switch (value) {
    case 'all': props.exportAll?.(); return;
    case 'copy': emit('copied', await copyText(toCsv(props.table, props.table.rows))); return;
    case 'csv': save(toCsv(props.table, props.table.rows), 'text/csv;charset=utf-8', `${base}.csv`); return;
    case 'json': save(toJson(props.table, props.table.rows), 'application/json;charset=utf-8', `${base}.json`); return;
    case 'full': full.value = !full.value; return;
    case 'settings': settingsOpen.value = true; return;
    case 'png':
    case 'svg': {
      const exporter = image.value;
      if (exporter !== undefined) { saveUrl(exporter(value), `${base}.${value}`); }
    }
  }
}

function drill(row: number): void {
  if (props.drills) { emit('drill', row); return; }
  const cells: readonly Json[] | undefined = props.table.rows[row];
  if (cells !== undefined && props.opener?.has(cells) === true) { props.opener.open(cells); }
}

// Escape leaves full screen, unless a dialog or popover over it takes the key first
function onKey(event: KeyboardEvent): void { if (event.key === 'Escape' && !event.defaultPrevented && !settingsOpen.value) { full.value = false; } }
watch(full, (on) => {
  if (on) { document.addEventListener('keydown', onKey); } else { document.removeEventListener('keydown', onKey); }
});
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); });
</script>

<template>
  <div class="result" :class="{ full }" data-testid="result-view" :data-visual="shown?.ranked.visual.name" :data-style="shown?.style" :role="full ? 'dialog' : undefined" :aria-label="full ? title : undefined">
    <div class="tools">
      <div v-if="slots.context || slots.lead" class="context">
        <slot name="context" />
        <div v-if="slots.lead" class="lead"><slot name="lead" /></div>
      </div>
      <span class="actions">
        <!-- a widget's chosen few scroll sideways rather than wrap -->
        <div v-if="toggled" class="families"><UiSegmented v-model="family" :options="families" label="Show as" icon-only class="compact" data-testid="result-visuals" /></div>
        <slot name="tools" />
        <UiMenu :items="menu" label="Widget menu" @select="pick">
          <template #trigger="{ toggle: toggleMenu, attrs }">
            <UiIconButton icon="more" label="More" size="sm" class="more" v-bind="attrs" data-testid="widget-more" @click="toggleMenu" />
          </template>
        </UiMenu>
        <UiIconButton v-if="full" icon="x" label="Leave full screen" size="sm" data-testid="result-full-close" @click="full = false" />
      </span>
    </div>
    <DrawVisual v-if="shown" :visual="shown.ranked.visual.component" :drawn="drawn" />
    <UiDialog v-model:open="settingsOpen" title="Settings" :description="`How “${title}” looks.`" width="440px">
      <div class="settings" data-testid="result-settings">
        <div class="setting">
          <span class="setting-label">Show as</span>
          <UiSegmented v-model="family" :options="allFamilies" label="Show as" data-testid="result-settings-visuals" />
        </div>
        <UiSelect v-if="styles.length > 1" v-model="style" :options="styles" label="Style" data-testid="result-style" />
      </div>
      <template #footer>
        <slot name="settings" :close="() => { settingsOpen = false; }" />
        <UiButton variant="primary" data-testid="result-settings-done" @click="settingsOpen = false">Done</UiButton>
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.result { position: relative; display: grid; align-content: start; gap: var(--space-2); min-width: 0; }
.result.full {
  position: fixed; inset: 0; z-index: var(--z-dialog); overflow: auto; padding: var(--space-3) var(--space-4) var(--space-4);
  background: var(--surface); --chart-full: calc(100dvh - 120px);
}
.tools { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.context { display: grid; flex: 1 1 auto; gap: var(--space-2); min-width: 0; }
.lead { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.actions { display: flex; flex: 0 1 auto; align-items: center; gap: 2px; min-width: 0; margin-left: auto; }
.families { flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.families::-webkit-scrollbar { display: none; }
.families :deep(.ui-segmented) { flex-wrap: nowrap; max-width: none; }
/* the toggle is small: icons only, tight */
.compact { padding: 2px; }
.compact :deep(.option) { min-height: 24px; padding: 0 6px; }
/* the menu shows while the view is hovered or holds focus, or while it is open; on a touch screen (no hover) it stays, faint */
.more { opacity: 0; transition: opacity var(--fast) var(--ease); }
.result:hover .more, .result:focus-within .more, .more[aria-expanded='true'], .full .more { opacity: 1; }
@media (hover: none) { .more { opacity: 0.6; } }
.settings { display: grid; gap: var(--space-4); }
.setting { display: grid; gap: var(--space-2); }
.setting-label { color: var(--text-dim); font-size: var(--text-sm); font-weight: var(--weight-medium); }
</style>
