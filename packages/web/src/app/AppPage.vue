<script setup lang="ts">
/**
 * A page's frame: its title, a line about it, actions on the right (`actions` slot) and its content, centred at a
 * readable or wide width, or across the whole width (`full`, for a page of panes), with the same spacing on every page. A `crumb` slot above the title leads back to where the page
 * sits. On phones the top bar already shows the page's name, so the title is kept for screen readers only, unless
 * `keepTitle` (a page about one thing, whose name the top bar can't know); then the name takes the row and the actions
 * wrap under it.
 */
import { COMPACT_QUERY } from '../state/layout.ts';
import { useMediaQuery } from '../ui/index.ts';

withDefaults(defineProps<{ title: string; description?: string; width?: 'readable' | 'wide' | 'full'; keepTitle?: boolean }>(), { description: '', width: 'wide', keepTitle: false });
const slots = defineSlots<{ default: () => unknown; actions?: () => unknown; crumb?: () => unknown }>();
const compact = useMediaQuery(COMPACT_QUERY);
</script>

<template>
  <div class="app-page" :class="[width, { compact, kept: keepTitle }]">
    <header class="head">
      <div class="titles">
        <div v-if="slots.crumb" class="crumb"><slot name="crumb" /></div>
        <h1 class="title" :class="{ 'sr-only': compact && !keepTitle }">{{ title }}</h1>
        <p v-if="description !== ''" class="description">{{ description }}</p>
      </div>
      <div v-if="slots.actions" class="actions"><slot name="actions" /></div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.app-page {
  display: grid; align-content: start; gap: var(--space-5); width: 100%; margin: 0 auto;
  padding: var(--space-6) var(--space-5) max(var(--space-7), var(--safe-bottom));
}
.wide { max-width: var(--content); }
.readable { max-width: calc(var(--readable) + 2 * var(--space-5)); }
.head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-3) var(--space-4); }
.titles { display: grid; gap: var(--space-1); min-width: 0; }
.title { margin: 0; font-size: var(--text-2xl); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); }
.crumb { display: flex; margin-bottom: var(--space-1); font-size: var(--text-sm); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.compact .title { font-size: var(--text-xl); }
/* on a phone the actions sit beside the title and its line while that leaves the line room to read (12rem); more
   actions than that fit wrap onto a row of their own under it, rather than squeezing the line to a word a row */
.compact .head { align-items: flex-start; }
.compact .titles { flex: 1 1 12rem; }
.compact .description { font-size: var(--text-sm); }
.compact .actions { flex: none; }
/* a page about one thing keeps its (often long) name: the name takes the row and the actions wrap under it */
.compact.kept .head { flex-wrap: wrap; }
.compact.kept .titles { flex-basis: 100%; }
.compact.kept .actions { flex: 1 1 100%; }
.compact { padding: var(--space-4) var(--space-4) max(var(--space-6), var(--safe-bottom)); gap: var(--space-4); }
</style>
