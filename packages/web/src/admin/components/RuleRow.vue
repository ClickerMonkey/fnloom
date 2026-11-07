<script setup lang="ts">
/**
 * One rule in a list (a provider, a category, a budget, a priority rule, a policy): an icon, what it is, a line of
 * detail, badges, room for a measure (a budget's meter), and Edit and Remove when offered.
 */
import { UiIcon, UiIconButton, type IconName } from '../../ui/index.ts';

withDefaults(defineProps<{
  icon: IconName;
  title: string;
  detail?: string;
  editable?: boolean;
  removable?: boolean;
  /** What the buttons' labels name: "Edit {label}". */
  label?: string;
}>(), { detail: '', editable: true, removable: true, label: '' });
const emit = defineEmits<{ edit: []; remove: [] }>();
const slots = defineSlots<{ badges?: () => unknown; measure?: () => unknown }>();
</script>

<template>
  <li class="rule-row">
    <span class="mark" aria-hidden="true"><UiIcon :name="icon" :size="16" /></span>
    <div class="main">
      <p class="title">{{ title }}</p>
      <p v-if="detail !== ''" class="detail">{{ detail }}</p>
      <p v-if="slots.badges" class="badges"><slot name="badges" /></p>
    </div>
    <div v-if="slots.measure" class="measure"><slot name="measure" /></div>
    <div v-if="editable || removable" class="tools">
      <UiIconButton v-if="editable" icon="edit" :label="`Edit ${label || title}`" data-testid="edit" @click="emit('edit')" />
      <UiIconButton v-if="removable" icon="trash" :label="`Remove ${label || title}`" data-testid="remove" @click="emit('remove')" />
    </div>
  </li>
</template>

<style scoped>
.rule-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 220px) auto; align-items: center; gap: var(--space-3) var(--space-4);
  padding: var(--space-3) var(--space-4); animation: ui-fade-in var(--medium) var(--ease);
}
.rule-row + .rule-row { border-top: 1px solid var(--border); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: 2px; min-width: 0; }
.title { margin: 0; font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.detail { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.badges { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: var(--space-1) 0 0; }
.measure { min-width: 0; }
.tools { display: flex; gap: 2px; }
.rule-row:not(:has(.measure)) { grid-template-columns: auto minmax(0, 1fr) auto; }
@media (max-width: 559.98px) {
  .rule-row, .rule-row:not(:has(.measure)) { grid-template-columns: auto minmax(0, 1fr) auto; }
  .measure { grid-row: 2; grid-column: 2 / -1; }
}
</style>
