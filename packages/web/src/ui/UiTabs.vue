<script setup lang="ts" generic="V extends string">
/**
 * Tabs (`v-model` is the chosen tab's value). The tab list scrolls sideways when it doesn't fit; arrow keys, Home and
 * End move between tabs. The default slot renders the chosen panel and gets its value. Binding `v-model` to the URL is
 * the page's job, so a refresh returns to the same tab.
 */
import { nextTick, onMounted, ref, useId, watch } from 'vue';
import UiIcon from './UiIcon.vue';
import { useMoreEdges } from './edges.ts';
import { countLabel } from './format.ts';
import { roveFocus } from './keys.ts';
import type { TabItem } from './types.ts';

const props = defineProps<{ tabs: readonly TabItem<V>[]; label: string }>();
const model = defineModel<V>({ required: true });
const id = useId();
const list = ref<HTMLElement | null>(null);
const edges = useMoreEdges(list);

/** Keep the chosen tab in view when the strip scrolls sideways (phones). */
function reveal(): void {
  list.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
watch(model, () => { void nextTick(reveal); });
onMounted(reveal);

function choose(at: number): void {
  const tab = props.tabs[at];
  if (tab) { model.value = tab.value; }
}

const slots = defineSlots<{ default?: (props: { value: V }) => unknown }>();
</script>

<template>
  <div class="ui-tabs">
    <div ref="list" class="list edge-fade" :data-more="edges" role="tablist" :aria-label="label" data-roving>
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
    <div v-if="slots.default" :id="`${id}-panel`" class="panel" role="tabpanel" :aria-labelledby="`${id}-tab-${model}`" tabindex="0">
      <Transition name="ui-tab" mode="out-in">
        <div :key="model"><slot :value="model" /></div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.ui-tabs { display: grid; gap: var(--space-4); min-width: 0; }
.list {
  display: flex; gap: var(--space-1); overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--border);
  margin: 0 calc(var(--space-1) * -1); padding: 0 var(--space-1);
}
.list::-webkit-scrollbar { display: none; }
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
