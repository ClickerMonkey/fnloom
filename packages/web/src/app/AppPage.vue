<script setup lang="ts">
/**
 * A page's frame: its title, a line about it, actions on the right (`actions` slot) and its content, centred at a
 * readable or wide width, or across the whole width (`full`, for a page of panes), with the same spacing on every page. A `crumb` slot above the title leads back to where the page
 * sits. On phones the top bar already shows the page's name, so the title is kept for screen readers only. A page about
 * one thing (`keepTitle`: a system, a fn) tells the top bar its title, so the bar says `fs` rather than "System".
 * The actions sit to the right of the title on every screen; more than fit beside it wrap under it.
 */
import { onBeforeUnmount, watch } from 'vue';
import { COMPACT_QUERY } from '../state/layout.ts';
import { useStoresIfAny } from '../state/stores.ts';
import { useMediaQuery } from '../ui/index.ts';

const props = withDefaults(defineProps<{ title: string; description?: string; width?: 'readable' | 'wide' | 'full'; keepTitle?: boolean }>(), { description: '', width: 'wide', keepTitle: false });
const slots = defineSlots<{ default: () => unknown; actions?: () => unknown; crumb?: () => unknown }>();
const compact = useMediaQuery(COMPACT_QUERY);
const layout = useStoresIfAny()?.layout;
// only a page that keeps its title writes it (a plain page, or one drawn inside another, leaves the bar's name alone)
if (layout !== undefined && props.keepTitle) {
  watch(() => props.title, (title) => { layout.pageTitle.value = title; }, { immediate: true });
  onBeforeUnmount(() => { if (layout.pageTitle.value === props.title) { layout.pageTitle.value = undefined; } });
}
</script>

<template>
  <div class="app-page" :class="[width, { compact }]">
    <header class="head">
      <div class="titles">
        <div v-if="slots.crumb" class="crumb"><slot name="crumb" /></div>
        <h1 class="title" :class="{ 'sr-only': compact }">{{ title }}</h1>
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
/* the title and its line take the room; the actions keep theirs beside it (wrapping under only when the line would
   be squeezed under 16rem), so a page never leaves them alone on a half-empty row */
.head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--space-3) var(--space-4); }
.titles { display: grid; flex: 1 1 16rem; gap: var(--space-1); min-width: 0; }
.title { margin: 0; font-size: var(--text-2xl); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); }
.crumb { display: flex; margin-bottom: var(--space-1); font-size: var(--text-sm); }
.actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.compact .title { font-size: var(--text-xl); }
/* on a phone the actions sit beside the title and its line while that leaves the line room to read (12rem); more
   actions than that fit wrap onto a row of their own under it, rather than squeezing the line to a word a row, and wrap
   among themselves when even that row is too narrow */
.compact .head { align-items: flex-start; }
.compact .titles { flex: 1 1 12rem; }
.compact .description { font-size: var(--text-sm); }
.compact .actions { flex: none; max-width: 100%; }
.compact { padding: var(--space-4) var(--space-4) max(var(--space-6), var(--safe-bottom)); gap: var(--space-4); }
</style>
