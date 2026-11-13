<script setup lang="ts">
/**
 * What a system added beyond its fns, context and types, one kind at a time: a row of choices (resource roots, kinds,
 * commands, providers, components, examples, ... each with its count, only the kinds it has) and that kind's list,
 * each item with its switch when the page offers them. The kind shown is in the URL (`?part=`).
 */
import type { ItemRef, QualifiedName, ResourceRoot, SystemName, SystemPartSection } from '@harness/core';
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { partChoices, shownPart, type PartGroup } from '../logic/systems.ts';
import type { PartTab } from '../sections.ts';
import SystemPartList from './SystemPartList.vue';

const props = withDefaults(defineProps<{
  groups: readonly PartGroup[];
  roots: readonly ResourceRoot[];
  rootPage: (root: ResourceRoot) => RouteLocationRaw;
  ownerPage: (section: SystemPartSection, owner: QualifiedName) => RouteLocationRaw;
  isOn?: ((item: ItemRef) => boolean) | undefined;
  busy?: boolean;
  /** The system the parts are of, for their version history. */
  system?: SystemName | undefined;
}>(), { isOn: undefined, busy: false, system: undefined });
const emit = defineEmits<{ switch: [item: ItemRef, on: boolean] }>();
const part = defineModel<PartTab>('part', { required: true });

const choices = computed(() => partChoices(props.groups, props.roots.length));
const shown = computed(() => shownPart(choices.value, part.value));
const groups = computed(() => props.groups.filter((group) => group.section === shown.value));
</script>

<template>
  <div class="parts" data-testid="parts-by-kind">
    <div class="choices" role="group" aria-label="Kind of part">
      <button
        v-for="choice in choices" :key="choice.value" type="button" class="choice" :aria-pressed="shown === choice.value" :data-part-tab="choice.value"
        @click="part = choice.value"
      >
        {{ choice.label }} <span class="count">{{ choice.count }}</span>
      </button>
    </div>
    <SystemPartList
      :groups="groups" :roots="shown === 'roots' ? roots : []" :root-page="rootPage" :owner-page="ownerPage" :is-on="isOn" :busy="busy" :system="system"
      @switch="(item, on) => emit('switch', item, on)"
    />
  </div>
</template>

<style scoped>
.parts { display: grid; gap: var(--space-3); min-width: 0; }
.choices { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.choice {
  display: inline-flex; align-items: center; gap: var(--space-1); height: var(--control-sm); padding: 0 var(--space-3); border: 1px solid var(--border);
  border-radius: 999px; background: var(--surface); color: var(--text-dim); font: inherit; font-size: var(--text-sm); cursor: pointer;
}
.choice:hover { color: var(--text); background: var(--surface-2); }
.choice:focus-visible { outline: none; box-shadow: var(--ring); }
.choice[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.count { color: var(--text-faint); font-variant-numeric: tabular-nums; }
</style>
