<script setup lang="ts" generic="V extends string">
/**
 * A choice from a list, with its label, hint and error (`v-model` is the chosen value). It is the device's own
 * select, so phones show their native picker and keyboards work as people expect; it is styled like `UiInput`.
 */
import UiField from './UiField.vue';
import UiIcon from './UiIcon.vue';
import type { SelectOption } from './types.ts';

const props = withDefaults(defineProps<{
  options: readonly SelectOption<V>[];
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  size?: 'sm' | 'md';
}>(), { label: '', hint: '', error: '', required: false, disabled: false, hideLabel: false, size: 'md' });

const model = defineModel<V>({ required: true });

/** The person chose: take the option whose value it is (never a value outside the list). */
function choose(event: Event): void {
  if (!(event.target instanceof HTMLSelectElement)) { return; }
  const raw = event.target.value;
  const option = props.options.find((o) => o.value === raw);
  if (option !== undefined) { model.value = option.value; }
}
</script>

<template>
  <UiField v-slot="field" :label="label" :hint="hint" :error="error" :required="required" :hide-label="hideLabel">
    <div class="ui-select" :class="[size, { invalid: field.invalid, disabled }]">
      <select
        :id="field.id" :disabled="disabled" :required="required" :aria-invalid="field.invalid ? 'true' : undefined" :aria-describedby="field.describedBy"
        @change="choose"
      >
        <option v-for="option in options" :key="option.value" :value="option.value" :selected="option.value === model" :disabled="option.disabled">{{ option.label }}</option>
      </select>
      <UiIcon name="chevron-down" :size="16" class="chevron" />
    </div>
  </UiField>
</template>

<style scoped>
.ui-select {
  position: relative; display: flex; align-items: center; min-width: 0; height: var(--control);
  border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface);
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.ui-select:hover { border-color: var(--text-faint); }
.ui-select:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.ui-select.invalid { border-color: var(--danger); }
.ui-select.disabled { opacity: 0.55; }
.sm { height: var(--control-sm); border-radius: var(--radius-sm); }
select {
  flex: 1; min-width: 0; height: 100%; padding: 0 calc(var(--space-3) + 20px) 0 var(--space-3); border: 0; border-radius: inherit;
  background: transparent; color: var(--text); font: inherit; outline: none; appearance: none; cursor: pointer;
  text-overflow: ellipsis;
}
select option { background: var(--surface); color: var(--text); }
.chevron { position: absolute; right: var(--space-3); color: var(--text-faint); pointer-events: none; }
</style>
