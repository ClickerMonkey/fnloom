<script setup lang="ts">
/**
 * A new, empty chat: a welcome and a few starters to tap. Starters come from the context the hub offers people
 * (its `/` commands), topped up with general ones; tapping one sends it.
 */
import { UiIcon } from '../../ui/index.ts';
import type { Starter } from './types.ts';

defineProps<{ starters: readonly Starter[]; agent: string }>();
const emit = defineEmits<{ pick: [starter: Starter] }>();
</script>

<template>
  <div class="starters" data-testid="starters">
    <div class="welcome">
      <span class="mark"><UiIcon name="sparkles" :size="22" /></span>
      <h2 class="title">What can {{ agent }} do for you?</h2>
      <p class="body">Ask anything, mention files with @, add context with /, or run a fn with !.</p>
    </div>
    <ul class="grid">
      <li v-for="starter in starters" :key="starter.key">
        <button type="button" class="starter" data-testid="starter" @click="emit('pick', starter)">
          <UiIcon :name="starter.icon" :size="16" />
          <span class="text">{{ starter.title }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.starters {
  /* one column no wider than the thread: an implicit `auto` track would size to the grid's max-content and overflow a phone */
  display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: var(--space-5); justify-items: center; padding: var(--space-7) var(--space-2) var(--space-4); animation: ui-rise-in var(--slow) var(--ease); }
.welcome { display: grid; justify-items: center; gap: var(--space-2); max-width: 100%; min-width: 0; text-align: center; }
.mark { display: grid; place-items: center; width: 48px; height: 48px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent); }
.title { margin: var(--space-2) 0 0; overflow-wrap: anywhere; font-size: var(--text-xl); font-weight: var(--weight-strong); }
.body { margin: 0; max-width: min(46ch, 100%); overflow-wrap: anywhere; color: var(--text-dim); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: var(--space-2); width: 100%; max-width: 640px; margin: 0; padding: 0; list-style: none; }
.starter {
  display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 52px; padding: var(--space-3) var(--space-4); border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--surface); color: var(--text); text-align: left;
  transition: border-color var(--fast) var(--ease), transform var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.starter :deep(svg) { color: var(--accent); flex: none; }
.starter:hover { border-color: var(--accent); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
.starter:focus-visible { outline: none; box-shadow: var(--ring); }
.text { min-width: 0; }
</style>
