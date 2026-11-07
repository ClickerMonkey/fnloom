<script setup lang="ts">
/**
 * Making or changing a model category: a name, what it is for, and its models in order (agents start with the first
 * and move down when quality demands it). Models are added from the providers' lists and reordered with buttons.
 */
import type { ModelCategory } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiIconButton, UiInput, UiSelect, UiTextarea, type SelectOption } from '../../ui/index.ts';
import { categoryBody, categoryDraft, type CategoryBody, type CategoryDraft } from '../logic/forms.ts';

const props = withDefaults(defineProps<{ category?: ModelCategory | undefined; models: readonly string[]; busy?: boolean; problem?: string }>(), { category: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [body: CategoryBody] }>();

const draft = ref<CategoryDraft>(categoryDraft());
const adding = ref('');
const tried = ref(false);
const checked = computed(() => categoryBody(draft.value));
const errorOf = (field: keyof CategoryBody): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');
const choices = computed<readonly SelectOption<string>[]>(() => [
  { value: '', label: 'Choose a model…' },
  ...props.models.filter((m) => !draft.value.models.includes(m)).map((m) => ({ value: m, label: m })),
]);

watch(open, (isOpen) => { if (isOpen) { draft.value = categoryDraft(props.category); adding.value = ''; tried.value = false; } });
watch(adding, (model) => {
  if (model === '') { return; }
  draft.value = { ...draft.value, models: [...draft.value.models, model] };
  adding.value = '';
});

function move(index: number, by: -1 | 1): void {
  const models = [...draft.value.models];
  const [model] = models.splice(index, 1);
  if (model === undefined) { return; }
  models.splice(index + by, 0, model);
  draft.value = { ...draft.value, models };
}

function remove(index: number): void {
  draft.value = { ...draft.value, models: draft.value.models.filter((_, i) => i !== index) };
}

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="category ? `Edit ${category.name}` : 'New model category'" description="Agents pick a category, not a model." width="520px">
    <form class="form" novalidate data-testid="category-form" @submit.prevent="save">
      <UiInput v-model="draft.name" label="Name" placeholder="fast" required :error="errorOf('name')" />
      <UiTextarea v-model="draft.description" label="What it is for" placeholder="Quick answers that don't need deep thought" :rows="2" />
      <div class="models">
        <p class="label">Models, first tried first</p>
        <ol v-if="draft.models.length > 0" class="list">
          <li v-for="(model, index) in draft.models" :key="model" class="item">
            <span class="rank">{{ index + 1 }}</span>
            <code class="model">{{ model }}</code>
            <span class="tools">
              <UiIconButton icon="chevron-up" label="Move up" size="sm" :disabled="index === 0" @click="move(index, -1)" />
              <UiIconButton icon="chevron-down" label="Move down" size="sm" :disabled="index === draft.models.length - 1" @click="move(index, 1)" />
              <UiIconButton icon="x" label="Remove" size="sm" @click="remove(index)" />
            </span>
          </li>
        </ol>
        <UiSelect v-model="adding" :options="choices" label="Add a model" hide-label :error="errorOf('models')" />
      </div>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="category-save" @click="save">Save category</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.models { display: grid; gap: var(--space-2); }
.label { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.list { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.item { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2); border-radius: var(--radius); background: var(--surface-2); }
.rank { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; text-align: center; }
.model { overflow: hidden; font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.tools { display: flex; }
</style>
