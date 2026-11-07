<script setup lang="ts">
/** A slim message across a pane (connection lost, a system needs setup), in a tone, with an `actions` slot. */
import UiIcon from './UiIcon.vue';
import { TONE_ICON, type IconName } from './icons.ts';
import type { Tone } from './types.ts';

withDefaults(defineProps<{ tone?: Tone; icon?: IconName | undefined }>(), { tone: 'neutral', icon: undefined });
const slots = defineSlots<{ default: () => unknown; actions?: () => unknown }>();
</script>

<template>
  <div class="ui-banner" :class="`tone-${tone}`" :role="tone === 'danger' || tone === 'warn' ? 'alert' : 'status'">
    <UiIcon :name="icon ?? TONE_ICON[tone]" :size="16" class="icon" />
    <div class="text"><slot /></div>
    <div v-if="slots.actions" class="actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.ui-banner {
  display: flex; align-items: center; gap: var(--space-3); min-width: 0; padding: var(--space-2) var(--space-4);
  background: var(--tone-soft); color: var(--text); border-radius: var(--radius); font-size: var(--text-sm);
  animation: ui-rise-in var(--medium) var(--ease);
}
.tone-neutral { --tone-soft: var(--surface-2); }
.icon { color: var(--tone); }
.text { flex: 1; min-width: 0; }
.actions { display: flex; gap: var(--space-2); flex: none; }
</style>
