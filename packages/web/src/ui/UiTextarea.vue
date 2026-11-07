<script setup lang="ts">
/**
 * A multi-line text input that grows with its text up to `maxRows`, then scrolls (`v-model` is the text).
 */
import { nextTick, onMounted, ref, watch } from 'vue';
import UiField from './UiField.vue';

const props = withDefaults(defineProps<{
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  rows?: number;
  maxRows?: number;
  required?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
}>(), { label: '', hint: '', error: '', placeholder: '', rows: 3, maxRows: 12, required: false, disabled: false, hideLabel: false });

const model = defineModel<string>({ required: true });
const area = ref<HTMLTextAreaElement | null>(null);

function fit(): void {
  const el = area.value;
  if (!el) { return; }
  const style = getComputedStyle(el);
  const line = Number.parseFloat(style.lineHeight) || 22;
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, line * props.maxRows + padding)}px`;
}

watch(model, () => { void nextTick(fit); });
onMounted(fit);
defineExpose({ focus: () => area.value?.focus() });
</script>

<template>
  <UiField v-slot="field" :label="label" :hint="hint" :error="error" :required="required" :hide-label="hideLabel">
    <textarea
      :id="field.id" ref="area" v-model="model" class="ui-textarea" :class="{ invalid: field.invalid }" :rows="rows"
      :placeholder="placeholder" :required="required" :disabled="disabled" :aria-invalid="field.invalid ? 'true' : undefined"
      :aria-describedby="field.describedBy"
    />
  </UiField>
</template>

<style scoped>
.ui-textarea {
  display: block; width: 100%; min-width: 0; padding: var(--space-2) var(--space-3); resize: none;
  border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); line-height: var(--leading);
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.ui-textarea:hover { border-color: var(--text-faint); }
.ui-textarea:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.ui-textarea.invalid { border-color: var(--danger); }
.ui-textarea::placeholder { color: var(--text-faint); }
.ui-textarea:disabled { opacity: 0.55; }
</style>
