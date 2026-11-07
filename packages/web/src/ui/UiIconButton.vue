<script setup lang="ts">
/**
 * A square button with only an icon. `label` is required: it is the button's accessible name and its tooltip. An
 * optional `badge` shows a count (or a dot for `true`) on its corner. Its `click` event's `currentTarget` anchors popovers.
 */
import UiIcon from './UiIcon.vue';
import { countLabel } from './format.ts';
import type { IconName } from './icons.ts';

withDefaults(defineProps<{
  icon: IconName;
  label: string;
  size?: 'sm' | 'md';
  /** A count, or `true` for a dot. Hidden when 0 or false. */
  badge?: number | boolean;
  /** Pressed state, for toggles; null for a plain button. */
  pressed?: boolean | null;
  disabled?: boolean;
}>(), { size: 'md', badge: false, pressed: null, disabled: false });

defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <button
    type="button" class="ui-icon-button" :class="size" :aria-label="label" :title="label"
    :aria-pressed="pressed === null ? undefined : pressed ? 'true' : 'false'" :disabled="disabled" @click="$emit('click', $event)"
  >
    <UiIcon :name="icon" :size="size === 'sm' ? 16 : 20" />
    <span v-if="badge === true" class="badge dot" aria-hidden="true" />
    <span v-else-if="typeof badge === 'number' && badge > 0" :key="badge" class="badge count" aria-hidden="true">{{ countLabel(badge) }}</span>
  </button>
</template>

<style scoped>
.ui-icon-button {
  position: relative; display: inline-grid; place-items: center; flex: none;
  width: var(--control); height: var(--control); padding: 0; border: 0; border-radius: var(--radius);
  background: transparent; color: var(--text-dim);
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease), transform var(--fast) var(--ease);
  -webkit-tap-highlight-color: transparent;
}
.ui-icon-button:hover:not(:disabled), .ui-icon-button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); }
.ui-icon-button:active:not(:disabled) { transform: scale(0.94); }
.ui-icon-button:focus-visible { outline: none; box-shadow: var(--ring); }
.ui-icon-button:disabled { opacity: 0.45; }
.sm { width: var(--control-sm); height: var(--control-sm); border-radius: var(--radius-sm); }
.badge { position: absolute; pointer-events: none; }
.dot { top: 8px; right: 8px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }
.count {
  top: 2px; right: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-full);
  background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: var(--weight-strong); line-height: 18px; text-align: center;
  box-shadow: 0 0 0 2px var(--surface); animation: ui-pop-in var(--medium) var(--spring);
}
</style>
