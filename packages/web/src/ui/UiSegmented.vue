<script setup lang="ts" generic="T extends string">
/**
 * A small set of mutually exclusive choices shown side by side (a radio group). `v-model` is the chosen option's
 * value; arrow keys move between options.
 */
import UiIcon from './UiIcon.vue';
import { roveFocus } from './keys.ts';
import type { SegmentOption } from './types.ts';

const props = defineProps<{ options: readonly SegmentOption<T>[]; label: string }>();
const model = defineModel<T>({ required: true });

function choose(at: number): void {
  const option = props.options[at];
  if (option) { model.value = option.value; }
}
</script>

<template>
  <div class="ui-segmented" role="radiogroup" data-roving :aria-label="label">
    <button
      v-for="(option, index) in options" :key="option.value" type="button" role="radio" class="option"
      :aria-checked="model === option.value ? 'true' : 'false'" :tabindex="model === option.value ? 0 : -1"
      @click="model = option.value" @keydown="roveFocus($event, index, '[role=radio]', 'both', choose)"
    >
      <UiIcon v-if="option.icon" :name="option.icon" :size="16" />
      <span>{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.ui-segmented { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); max-width: 100%; }
.option {
  display: inline-flex; align-items: center; gap: var(--space-2); height: calc(var(--control) - 8px); padding: 0 var(--space-3);
  border: 0; border-radius: calc(var(--radius) - 3px); background: transparent; color: var(--text-dim); font-size: var(--text-sm); font-weight: var(--weight-medium);
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.option:hover { color: var(--text); }
.option[aria-checked='true'] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.option:focus-visible { outline: none; box-shadow: var(--ring); }
</style>
