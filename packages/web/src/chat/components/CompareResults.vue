<script setup lang="ts">
/**
 * An A/B compare's answers: side by side as columns on wide screens, one tab per variant on a phone (the tab is in
 * the URL, `&v=`). Each column is a `CompareColumn`. Once one is chosen, its answer is in the chat and the others say
 * what they already did. The header says how it stands and what each variant was reserved.
 */
import type { ApprovalId, ChatCapabilities, Json, Remember, VariantIndex } from '@harness/core';
import { computed } from 'vue';
import { UiBanner, UiIcon, UiIconButton, UiSkeleton, UiTabs, type TabItem } from '../../ui/index.ts';
import { variantIndex, variantLetter, variantParam, type VariantParam } from '../logic/compare.ts';
import { formatCost } from '../logic/format.ts';
import type { CompareStore } from '../state/compare.ts';
import CompareColumn from './CompareColumn.vue';

const props = defineProps<{
  store: CompareStore;
  models: ChatCapabilities['models'];
  /** One variant at a time, as tabs (a phone). */
  tabs: boolean;
}>();
/** The variant shown first (the tab on a phone), from 1, as the URL has it. */
const shown = defineModel<VariantParam | undefined>('variant', { required: true });
const emit = defineEmits<{ close: []; chosen: [variant: VariantIndex] }>();

const view = computed(() => props.store.view.value.value);
const variants = computed(() => view.value?.variants ?? []);
const tab = computed<VariantParam>({
  get: () => shown.value ?? variantParam(view.value?.chosen ?? 0),
  set: (value) => { shown.value = value; },
});
const tabItems = computed<TabItem<VariantParam>[]>(() => variants.value.map((v) => ({ value: variantParam(v.variant), label: `${variantLetter(v.variant)} · ${v.label}` })));
const visible = computed(() => (props.tabs ? variants.value.filter((v) => v.variant === variantIndex(tab.value)) : variants.value));
const running = computed(() => variants.value.filter((v) => v.status === 'running' || v.status === 'paused').length);
const headline = computed(() => {
  const v = view.value;
  if (v === undefined) { return ''; }
  if (v.chosen !== undefined) { return `Variant ${variantLetter(v.chosen)} is in the chat`; }
  if (running.value > 0) { return `${running.value} of ${v.variants.length} still answering`; }
  return 'Choose the answer you want';
});
const effectsOf = (variant: VariantIndex) => view.value?.discarded.find((d) => d.variant === variant)?.effects ?? [];

async function choose(variant: VariantIndex, adopt: boolean): Promise<void> {
  if ((await props.store.choose(variant, adopt)).ok) { emit('chosen', variant); }
}

function decide(id: ApprovalId, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): void {
  void props.store.decide(id, approve, remember, reason, answer);
}
</script>

<template>
  <div class="results" data-testid="compare-results">
    <header class="top">
      <UiIcon name="columns" :size="18" class="icon" />
      <div class="titles">
        <h2>Compare</h2>
        <p class="dim" aria-live="polite">
          {{ headline }}<template v-if="view"> · {{ formatCost(view.reserved) }} reserved for each</template>
        </p>
      </div>
      <UiIconButton icon="x" label="Close" data-testid="compare-close" @click="emit('close')" />
    </header>
    <UiBanner v-if="store.view.problem.value" tone="danger" class="banner">{{ store.view.problem.value }}</UiBanner>
    <UiBanner v-if="store.choosing.problem.value" tone="danger" class="banner">{{ store.choosing.problem.value }}</UiBanner>
    <UiTabs v-if="tabs && tabItems.length > 0" v-model="tab" class="tabs" :tabs="tabItems" label="Variants" />
    <div v-if="view === undefined" class="grid" :style="{ '--n': 2 }"><UiSkeleton v-for="n in 2" :key="n" shape="block" class="skeleton" /></div>
    <div v-else class="grid" :class="{ single: tabs }" :style="{ '--n': visible.length }">
      <CompareColumn
        v-for="variant in visible" :key="variant.variant" :variant="variant" :chosen="view.chosen" :reserved="view.reserved" :models="models"
        :streamed="store.streamed.value" :effects="effectsOf(variant.variant)" :choosing="store.choosing.busy.value"
        @choose="choose(variant.variant, $event)" @decide="decide"
      />
    </div>
  </div>
</template>

<style scoped>
.results { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
.icon { color: var(--accent); }
h2 { margin: 0; font-size: var(--text-lg); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.banner { margin: var(--space-2) var(--space-4) 0; }
.tabs { padding: 0 var(--space-3); }
.grid {
  flex: 1; min-height: 0; display: grid; gap: var(--space-3); padding: var(--space-3) var(--space-4) max(var(--space-3), var(--safe-bottom));
  grid-template-columns: repeat(var(--n), minmax(260px, 1fr)); overflow-x: auto; overflow-y: hidden;
}
.grid.single { grid-template-columns: minmax(0, 1fr); overflow-x: hidden; }
.skeleton { min-height: 240px; border-radius: var(--radius-lg); }
</style>
