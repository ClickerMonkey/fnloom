<script setup lang="ts">
/** A resource's menu of actions (open, download, copy its address, make context or a form, rename and delete for hub resources). */
import type { ResourceRecord } from '@harness/core';
import { computed } from 'vue';
import { UiIconButton, UiMenu, type MenuItem } from '../../ui/index.ts';
import { actionsFor, type ResourceAction } from '../logic/actions.ts';
import { nameOf } from '../logic/browse.ts';

const props = defineProps<{ record: ResourceRecord }>();
const emit = defineEmits<{ select: [action: ResourceAction] }>();

const items = computed<readonly MenuItem<ResourceAction>[]>(() => {
  const actions = actionsFor(props.record);
  const danger = actions.filter((a) => a.danger === true);
  const rest = actions.filter((a) => a.danger !== true);
  return [...rest.map((a) => ({ value: a.value, label: a.label, icon: a.icon })), ...(danger.length > 0 ? [{ kind: 'separator' as const }] : []), ...danger.map((a) => ({ value: a.value, label: a.label, icon: a.icon, danger: true }))];
});
</script>

<template>
  <span class="resource-menu">
    <UiMenu :items="items" :label="`Actions for ${nameOf(record)}`" @select="emit('select', $event)">
      <template #trigger="{ toggle, attrs }">
        <UiIconButton icon="more" size="sm" :label="`Actions for ${nameOf(record)}`" v-bind="attrs" data-testid="resource-menu" @click="toggle" />
      </template>
    </UiMenu>
  </span>
</template>
