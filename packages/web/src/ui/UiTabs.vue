<script setup lang="ts" generic="V extends string">
/**
 * Tabs (`v-model` is the chosen tab's value). The tab list scrolls sideways when it doesn't fit: by touch, by a mouse
 * wheel (a plain vertical one too, since the scrollbar is hidden) and by the arrow buttons that show at an end with
 * more beyond it. The chosen tab stays in view, clear of those arrows, when it is chosen and as the strip resizes.
 * Arrow keys, Home and End move between tabs. The default slot renders the chosen panel and gets its value. Binding
 * `v-model` to the URL is the page's job, so a refresh returns to the same tab.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import UiIcon from './UiIcon.vue';
import { useMoreEdges } from './edges.ts';
import { countLabel } from './format.ts';
import { roveFocus } from './keys.ts';
import { arrowScroll, revealScroll, wheelScroll } from './strip.ts';
import type { TabItem } from './types.ts';

const props = defineProps<{ tabs: readonly TabItem<V>[]; label: string }>();
const model = defineModel<V>({ required: true });
const id = useId();
const list = ref<HTMLElement | null>(null);
const edges = useMoreEdges(list);

/** Move the strip to `left`, gliding unless asked not to. */
function scrollTo(left: number, behavior: ScrollBehavior = 'smooth'): void {
  const el = list.value;
  if (el === null || left === el.scrollLeft) { return; }
  if (typeof el.scrollTo === 'function') { el.scrollTo({ left, behavior }); } else { el.scrollLeft = left; }
}

/** Keep the chosen tab in view, clear of the edge arrows. */
function reveal(behavior: ScrollBehavior = 'smooth'): void {
  const el = list.value;
  const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!el || !tab) { return; }
  scrollTo(revealScroll({ left: tab.offsetLeft, width: tab.offsetWidth }, el), behavior);
}

/** A vertical mouse wheel scrolls the strip sideways; at its end the wheel goes on to scroll the page. */
function wheel(event: WheelEvent): void {
  const el = list.value;
  const left = el === null ? undefined : wheelScroll(event, el);
  if (el === null || left === undefined) { return; }
  event.preventDefault();
  el.scrollLeft = left;
}

/** An edge arrow: page the strip towards its start (-1) or end (1). */
function page(direction: -1 | 1): void {
  if (list.value !== null) { scrollTo(arrowScroll(direction, list.value)); }
}

watch(model, () => { void nextTick(() => { reveal(); }); });
watch(() => props.tabs.length, () => { void nextTick(() => { reveal('auto'); }); });
let sizer: ResizeObserver | undefined;
onMounted(() => {
  reveal('auto');
  if (typeof ResizeObserver !== 'undefined' && list.value !== null) {
    sizer = new ResizeObserver(() => { reveal('auto'); });
    sizer.observe(list.value);
  }
});
onBeforeUnmount(() => { sizer?.disconnect(); });

function choose(at: number): void {
  const tab = props.tabs[at];
  if (tab) { model.value = tab.value; }
}

const slots = defineSlots<{ default?: (props: { value: V }) => unknown }>();
</script>

<template>
  <div class="ui-tabs">
    <div class="strip">
      <div ref="list" class="list edge-fade" :data-more="edges" role="tablist" :aria-label="label" data-roving @wheel="wheel">
        <button
          v-for="(tab, index) in tabs" :id="`${id}-tab-${tab.value}`" :key="tab.value" type="button" role="tab" class="tab"
          :aria-selected="model === tab.value ? 'true' : 'false'" :aria-controls="`${id}-panel`" :tabindex="model === tab.value ? 0 : -1"
          @click="model = tab.value" @keydown="roveFocus($event, index, '[role=tab]', 'horizontal', choose)"
        >
          <UiIcon v-if="tab.icon" :name="tab.icon" :size="16" />
          <span>{{ tab.label }}</span>
          <span v-if="tab.count !== undefined && tab.count > 0" class="count">{{ countLabel(tab.count) }}</span>
        </button>
      </div>
      <!-- mouse aids: touch swipes the strip and the keyboard moves between tabs, so the arrows stay out of the tab order -->
      <button v-if="edges === 'start' || edges === 'both'" type="button" class="arrow start" tabindex="-1" aria-label="Scroll tabs back" data-testid="tabs-back" @click="page(-1)">
        <UiIcon name="chevron-left" :size="16" />
      </button>
      <button v-if="edges === 'end' || edges === 'both'" type="button" class="arrow end" tabindex="-1" aria-label="Scroll tabs on" data-testid="tabs-on" @click="page(1)">
        <UiIcon name="chevron-right" :size="16" />
      </button>
    </div>
    <div v-if="slots.default" :id="`${id}-panel`" class="panel" role="tabpanel" :aria-labelledby="`${id}-tab-${model}`" tabindex="0">
      <Transition name="ui-tab" mode="out-in">
        <div :key="model"><slot :value="model" /></div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.ui-tabs { display: grid; gap: var(--space-4); min-width: 0; }
.strip { position: relative; min-width: 0; }
.list {
  position: relative; display: flex; gap: var(--space-1); overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--border);
  margin: 0 calc(var(--space-1) * -1); padding: 0 var(--space-1);
}
.list::-webkit-scrollbar { display: none; }
.arrow {
  position: absolute; top: 0; bottom: 1px; z-index: 1; display: grid; place-items: center; width: 28px; padding: 0; border: 0;
  border-radius: var(--radius-sm); background: var(--surface); color: var(--text-dim); box-shadow: var(--shadow-sm);
  animation: ui-fade-in var(--fast) var(--ease); transition: color var(--fast) var(--ease), background var(--fast) var(--ease);
}
.arrow.start { left: calc(var(--space-1) * -1); }
.arrow.end { right: calc(var(--space-1) * -1); }
.arrow:hover { color: var(--text); background: var(--surface-2); }
.arrow:active { transform: scale(0.94); }
/* a touch screen swipes the strip: the arrows are for a mouse */
@media (hover: none) { .arrow { display: none; } }
.tab {
  position: relative; display: inline-flex; align-items: center; gap: var(--space-2); flex: none; height: var(--control); padding: 0 var(--space-3);
  border: 0; background: transparent; color: var(--text-dim); font-weight: var(--weight-medium); white-space: nowrap;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0; transition: color var(--fast) var(--ease);
}
.tab::after {
  content: ''; position: absolute; left: var(--space-2); right: var(--space-2); bottom: -1px; height: 2px; border-radius: 2px;
  background: var(--accent); transform: scaleX(0); transition: transform var(--medium) var(--ease);
}
.tab:hover { color: var(--text); }
.tab[aria-selected='true'] { color: var(--text); }
.tab[aria-selected='true']::after { transform: scaleX(1); }
.tab:focus-visible { outline: none; box-shadow: inset var(--ring); }
.count { min-width: 20px; padding: 0 6px; border-radius: var(--radius-full); background: var(--surface-3); color: var(--text-dim); font-size: var(--text-xs); line-height: 20px; text-align: center; }
.panel { min-width: 0; }
.panel:focus-visible { outline: none; }
.ui-tab-enter-active, .ui-tab-leave-active { transition: opacity var(--fast) var(--ease), transform var(--fast) var(--ease); }
.ui-tab-enter-from { opacity: 0; transform: translateY(4px); }
.ui-tab-leave-to { opacity: 0; }
</style>
