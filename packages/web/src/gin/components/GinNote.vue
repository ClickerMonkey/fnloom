<script setup lang="ts">
/**
 * A comment or description behind a small info icon: hovering or pressing it shows the text; in edit mode the icon
 * opens a box to write it (`update:modelValue`). With no text and not editable, nothing shows.
 */
import { ref } from 'vue';
import { UiIcon, UiPopover, UiTextarea } from '../../ui/index.ts';

const props = withDefaults(defineProps<{
  modelValue: string;
  /** What the note is about, for its label (`Comment on Value`). */
  label: string;
  editable?: boolean;
}>(), { editable: false });

const emit = defineEmits<{ 'update:modelValue': [text: string] }>();
const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
</script>

<template>
  <span v-if="editable || modelValue !== ''" class="gin-note">
    <button
      ref="anchor" type="button" class="icon" :class="{ empty: modelValue === '' }" :aria-label="label" :title="editable ? undefined : modelValue" :aria-expanded="open"
      data-testid="gin-note" @click="open = !open"
    >
      <UiIcon :name="editable && modelValue === '' ? 'edit' : 'info'" />
    </button>
    <UiPopover v-model:open="open" :anchor="anchor" :label="label" :take-focus="editable">
      <UiTextarea
        v-if="editable" class="edit" :model-value="modelValue" :label="label" hide-label placeholder="What this does, for whoever reads it" :rows="3"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <p v-else class="text">{{ props.modelValue }}</p>
    </UiPopover>
  </span>
</template>

<style scoped>
.gin-note { display: inline-flex; vertical-align: middle; }
.icon { display: inline-grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--text-faint); cursor: pointer; font-size: 12px; }
.icon:hover, .icon:focus-visible, .icon[aria-expanded='true'] { color: var(--accent); background: var(--surface-2); }
.icon.empty { opacity: 0.6; }
.edit { width: min(320px, 80vw); }
.text { margin: 0; max-width: 320px; padding: var(--space-2) var(--space-3); font-size: var(--text-sm); white-space: pre-wrap; }
</style>
