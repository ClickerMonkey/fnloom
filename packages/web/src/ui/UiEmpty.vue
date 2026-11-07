<script setup lang="ts">
/** An empty, error or welcome state: an icon, a title, a line of explanation and an `actions` slot. */
import UiIcon from './UiIcon.vue';
import type { IconName } from './icons.ts';
import type { Tone } from './types.ts';

withDefaults(defineProps<{ icon?: IconName; title: string; body?: string; tone?: Tone }>(), { icon: 'sparkles', body: '', tone: 'neutral' });
const slots = defineSlots<{ actions?: () => unknown }>();
</script>

<template>
  <div class="ui-empty" :class="[`tone-${tone}`, { toned: tone !== 'neutral' }]">
    <span class="mark"><UiIcon :name="icon" :size="22" /></span>
    <h2 class="title">{{ title }}</h2>
    <p v-if="body !== ''" class="body">{{ body }}</p>
    <div v-if="slots.actions" class="actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.ui-empty { display: grid; justify-items: center; gap: var(--space-2); max-width: 420px; margin: 0 auto; padding: var(--space-7) var(--space-4); text-align: center; animation: ui-rise-in var(--slow) var(--ease); }
.mark { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: var(--space-2); border-radius: var(--radius-lg); background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border); }
.toned .mark { background: var(--tone-soft); color: var(--tone); border-color: transparent; }
.title { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-strong); }
.body { margin: 0; color: var(--text-dim); }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); margin-top: var(--space-3); }
</style>
