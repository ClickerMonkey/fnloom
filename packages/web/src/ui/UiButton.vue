<script setup lang="ts">
/**
 * A button. Variants: `primary` (the one main action), `secondary`, `ghost` (quiet, for toolbars) and `danger`.
 * While `loading` it shows a spinner, keeps its width and refuses clicks.
 */
import UiIcon from './UiIcon.vue';
import UiSpinner from './UiSpinner.vue';
import type { IconName } from './icons.ts';
import type { ButtonVariant, ControlSize } from './types.ts';

withDefaults(defineProps<{
  variant?: ButtonVariant;
  size?: ControlSize;
  type?: 'button' | 'submit' | 'reset';
  icon?: IconName | undefined;
  iconRight?: IconName | undefined;
  loading?: boolean;
  disabled?: boolean;
  /** Fill the width of its container. */
  block?: boolean;
}>(), { variant: 'secondary', size: 'md', type: 'button', icon: undefined, iconRight: undefined, loading: false, disabled: false, block: false });

defineEmits<{ click: [event: MouseEvent] }>();
const slots = defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <button
    class="ui-button" :class="[variant, size, { block, loading }]" :type="type" :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined" @click="$emit('click', $event)"
  >
    <span class="content">
      <UiIcon v-if="icon" :name="icon" :size="size === 'sm' ? 16 : 18" />
      <span v-if="slots.default" class="label"><slot /></span>
      <UiIcon v-if="iconRight" :name="iconRight" :size="size === 'sm' ? 16 : 18" />
    </span>
    <UiSpinner v-if="loading" class="spinner" :size="size === 'sm' ? 14 : 16" />
  </button>
</template>

<style scoped>
.ui-button {
  position: relative; display: inline-grid; place-items: center; min-width: 0;
  height: var(--control); padding: 0 var(--space-4); border: 1px solid transparent; border-radius: var(--radius);
  font-size: var(--text-md); font-weight: var(--weight-medium); line-height: 1; white-space: nowrap;
  transition: background-color var(--fast) var(--ease), border-color var(--fast) var(--ease), color var(--fast) var(--ease), box-shadow var(--fast) var(--ease), transform var(--fast) var(--ease);
  -webkit-tap-highlight-color: transparent;
}
.ui-button:active:not(:disabled) { transform: scale(0.98); }
.ui-button:focus-visible { outline: none; box-shadow: var(--ring); }
.ui-button:disabled:not(.loading) { opacity: 0.5; }
.content { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); min-width: 0; }
.label { overflow: hidden; text-overflow: ellipsis; }
.loading .content { visibility: hidden; }
.spinner { position: absolute; }
.block { display: grid; width: 100%; }

.sm { height: var(--control-sm); padding: 0 var(--space-3); font-size: var(--text-sm); border-radius: var(--radius-sm); }
.lg { height: var(--control-lg); padding: 0 var(--space-5); font-size: var(--text-lg); }

.primary { background: var(--accent); color: var(--on-accent); box-shadow: var(--shadow-sm); }
.primary:hover:not(:disabled) { background: var(--accent-hover); }
.secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
.secondary:hover:not(:disabled) { background: var(--surface-2); }
.ghost { background: transparent; color: var(--text-dim); }
.ghost:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.danger { background: var(--danger); color: #fff; }
.danger:hover:not(:disabled) { background: color-mix(in oklab, var(--danger) 88%, black); }
</style>
