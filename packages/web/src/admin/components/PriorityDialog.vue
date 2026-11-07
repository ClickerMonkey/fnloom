<script setup lang="ts">
/**
 * Making or changing a priority rule: where it applies, the priority used unless something more specific sets one,
 * and the ceiling nothing under it may run above.
 */
import { PRIORITIES, type Priority, type PriorityLevel, type PriorityRule } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiSelect, type SelectOption } from '../../ui/index.ts';
import { priorityBody, priorityDraft, type PriorityBody, type PriorityDraft } from '../logic/forms.ts';
import { LEVEL_NAME, PRIORITY_LEVELS, PRIORITY_WORD } from '../logic/limits.ts';
import type { ActorOption } from '../state/actors.ts';
import ScopePicker from './ScopePicker.vue';

const props = withDefaults(defineProps<{
  rule?: PriorityRule | undefined;
  actorsAt: (level: PriorityLevel) => readonly ActorOption[] | undefined;
  busy?: boolean;
  problem?: string;
}>(), { rule: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [body: PriorityBody] }>();

const levels = PRIORITY_LEVELS.map((level): SelectOption<PriorityLevel> => ({ value: level, label: LEVEL_NAME[level] }));
const priorities = (none: string): readonly SelectOption<Priority | ''>[] => [{ value: '', label: none }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_WORD[p] }))];
const defaults = priorities('Not set here');
const ceilings = priorities('No ceiling');

const draft = ref<PriorityDraft>(priorityDraft());
const tried = ref(false);
const checked = computed(() => priorityBody(draft.value));
const errorOf = (field: keyof PriorityBody): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');

watch(open, (isOpen) => { if (isOpen) { draft.value = priorityDraft(props.rule); tried.value = false; } });

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="rule ? 'Edit priority rule' : 'New priority rule'" description="The most specific level's default wins; the lowest ceiling caps it." width="520px">
    <form class="form" novalidate data-testid="priority-form" @submit.prevent="save">
      <ScopePicker v-model="draft.scope" :levels="levels" :actors-at="actorsAt" :error="errorOf('target')" />
      <div class="grid">
        <UiSelect v-model="draft.default" :options="defaults" label="Default" :error="errorOf('default')" />
        <UiSelect v-model="draft.max" :options="ceilings" label="Ceiling" :error="errorOf('max')" />
      </div>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="priority-save" @click="save">Save rule</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); align-items: start; gap: var(--space-3); }
</style>
