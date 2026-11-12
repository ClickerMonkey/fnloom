<script setup lang="ts">
/**
 * A one-line text input with its label, hint and error (`v-model` is the text, always a string, even for
 * `type="number"`, where Vue's own v-model would hand back a number). Optional leading icon and a clear button.
 * A password input can offer a show/hide button (`revealable`). `name` is the field's form name, which password
 * managers use to recognise a sign-in form. `focus()` is exposed for callers that move focus to it.
 */
import { computed, ref } from 'vue';
import UiField from './UiField.vue';
import UiIcon from './UiIcon.vue';
import type { IconName } from './icons.ts';

const props = withDefaults(defineProps<{
  label?: string;
  name?: string | undefined;
  revealable?: boolean;
  hint?: string;
  error?: string;
  type?: 'text' | 'email' | 'password' | 'search' | 'url' | 'number' | 'tel';
  placeholder?: string;
  autocomplete?: string;
  icon?: IconName | undefined;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  hideLabel?: boolean;
  autofocus?: boolean;
  size?: 'sm' | 'md';
}>(), {
  label: '', name: undefined, revealable: false, hint: '', error: '', type: 'text', placeholder: '', autocomplete: 'off', icon: undefined,
  required: false, disabled: false, clearable: false, hideLabel: false, autofocus: false, size: 'md',
});

const model = defineModel<string>({ required: true });
const emit = defineEmits<{ enter: [] }>();
const input = ref<HTMLInputElement | null>(null);
/** Whether a revealable password is shown as plain text. */
const shown = ref(false);
const canReveal = computed(() => props.revealable && props.type === 'password');
const shownType = computed(() => (canReveal.value && shown.value ? 'text' : props.type));

/** The text as typed. */
function onInput(event: Event): void {
  if (event.target instanceof HTMLInputElement) { model.value = event.target.value; }
}

function clear(): void {
  model.value = '';
  input.value?.focus();
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <UiField v-slot="field" :label="label" :hint="hint" :error="error" :required="required" :hide-label="hideLabel">
    <div class="ui-input" :class="[size, { invalid: field.invalid, disabled, 'has-icon': icon }]">
      <UiIcon v-if="icon" class="lead" :name="icon" :size="16" />
      <input
        :id="field.id" ref="input" :value="model" :type="shownType" :name="name" :placeholder="placeholder" :autocomplete="autocomplete"
        :required="required" :disabled="disabled" :aria-invalid="field.invalid ? 'true' : undefined" :aria-describedby="field.describedBy"
        :data-autofocus="autofocus ? '' : undefined" @input="onInput" @keydown.enter="emit('enter')"
      />
      <button
        v-if="canReveal" type="button" class="reveal" :aria-label="shown ? 'Hide password' : 'Show password'" :aria-pressed="shown ? 'true' : 'false'"
        :disabled="disabled" data-testid="reveal-password" @click="shown = !shown"
      >
        <UiIcon :name="shown ? 'eye-off' : 'eye'" :size="16" />
      </button>
      <button v-if="clearable && model !== ''" type="button" class="clear" aria-label="Clear" @click="clear">
        <UiIcon name="x" :size="14" />
      </button>
    </div>
  </UiField>
</template>

<style scoped>
.ui-input {
  display: flex; align-items: center; gap: var(--space-2); min-width: 0;
  height: var(--control); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.ui-input:hover { border-color: var(--text-faint); }
.ui-input:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.ui-input.invalid { border-color: var(--danger); }
.ui-input.invalid:focus-within { box-shadow: 0 0 0 3px var(--danger-soft); }
.ui-input.disabled { opacity: 0.55; }
.sm { height: var(--control-sm); border-radius: var(--radius-sm); }
.lead { color: var(--text-faint); }
input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; outline: none; }
input::placeholder { color: var(--text-faint); }
input[type='search']::-webkit-search-cancel-button { display: none; }
.clear {
  display: grid; place-items: center; flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--radius-full);
  background: var(--surface-3); color: var(--text-dim); transition: background-color var(--fast) var(--ease);
}
.reveal {
  display: grid; place-items: center; flex: none; width: 32px; height: 32px; margin-right: calc(-1 * var(--space-2)); padding: 0; border: 0;
  border-radius: var(--radius-sm); background: transparent; color: var(--text-dim); transition: color var(--fast) var(--ease);
}
.reveal:hover { color: var(--text); }
.reveal:focus-visible { outline: none; box-shadow: var(--ring); }
.clear:hover { background: var(--border-strong); color: var(--text); }
</style>
