<script setup lang="ts">
/**
 * The graph's own controls, in the search bar's slot beside the filters every list has: the focused item with how
 * many hops out (and a way back to everything), the systems drawn as one node each, and whether references outside
 * the systems shown are drawn. Over one graph query (`v-model`); `scoped` (a system's own graph) leaves out the
 * collapse menu, its one system being the point.
 */
import type { GraphQuery, SystemName } from '@harness/core';
import { computed } from 'vue';
import { UiButton, UiMenu, UiSegmented, UiSwitch } from '../../ui/index.ts';
import type { MenuItem } from '../../ui/types.ts';
import { withPart } from '../logic/graph.ts';

const props = withDefaults(defineProps<{
  /** The systems that may be collapsed. */
  systems?: readonly SystemName[];
  /** The focused item's name, to show on its chip. */
  focusName?: string;
  scoped?: boolean;
}>(), { systems: () => [], focusName: '', scoped: false });
const query = defineModel<GraphQuery>({ required: true });

const HOPS = [{ value: '1', label: '1 hop' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }] as const;
const hops = computed<'1' | '2' | '3' | '4'>({
  get: () => (['1', '2', '3', '4'] as const)[(query.value.focus?.hops ?? 1) - 1] ?? '1',
  set: (value) => { const focus = query.value.focus; if (focus !== undefined) { query.value = { ...query.value, focus: { node: focus.node, hops: Number(value) } }; } },
});
const collapsed = computed(() => query.value.collapse ?? []);
const collapseItems = computed<MenuItem<SystemName>[]>(() => props.systems.map((system) => ({
  value: system, label: system, ...(collapsed.value.includes(system) ? { icon: 'check' as const } : {}),
})));
const collapseLabel = computed(() => (collapsed.value.length === 0 ? 'Collapse' : `Collapsed (${collapsed.value.length})`));
const external = computed({ get: () => query.value.external !== false, set: (shown) => { query.value = withPart(query.value, 'external', shown ? undefined : false); } });

/** Collapse a system into one node, or draw it in full again. */
function toggleCollapse(system: SystemName): void {
  const next = collapsed.value.includes(system) ? collapsed.value.filter((name) => name !== system) : [...collapsed.value, system].sort();
  query.value = withPart(query.value, 'collapse', next);
}

function unfocus(): void {
  query.value = withPart(query.value, 'focus', undefined);
}
</script>

<template>
  <div v-if="query.focus" class="focus" data-testid="graph-focus-chip">
    <span class="focus-name" :title="focusName || query.focus.node">Around {{ focusName || query.focus.node }}</span>
    <UiSegmented v-model="hops" label="Hops out" :options="HOPS" />
    <UiButton size="sm" variant="ghost" icon="x" @click="unfocus">Everything</UiButton>
  </div>
  <UiMenu v-if="!scoped && systems.length > 0" :items="collapseItems" label="Draw a system as one node" @select="toggleCollapse">
    <template #trigger="{ toggle, attrs }">
      <UiButton size="sm" icon="layers" :variant="collapsed.length > 0 ? 'secondary' : 'ghost'" v-bind="attrs" data-testid="graph-collapse" @click="toggle">{{ collapseLabel }}</UiButton>
    </template>
  </UiMenu>
  <UiSwitch v-model="external" label="References outside" title="Draw what these items reference in other systems, greyed" data-testid="graph-external" />
</template>

<style scoped>
/* one row, as tall as the bar's other controls: on a narrow bar the name gives way (ellipsis) before the hops and the way back */
.focus { display: flex; flex-wrap: nowrap; align-items: center; gap: var(--space-2); min-width: 0; max-width: 100%; }
.focus > :deep(*) { flex: none; }
.focus-name { flex: 0 1 auto; min-width: 3ch; font-size: var(--text-sm); font-family: var(--mono); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
