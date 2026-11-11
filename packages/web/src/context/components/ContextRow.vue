<script setup lang="ts">
/**
 * One context item in the list: its origin's mark, its title (else its description; never its key) with its
 * description under a title, and badges for what sets it apart (its `/command`, the agents it is always given to, who
 * may see it when not everyone, the choices it offers, stale or forgotten), with its size and when it last changed.
 * `detailed` (a system's admin page) also says where it was declared (its contract or while running), its version and
 * who sees it, on every row, and leaves its origin's mark (every row there is the system's) and saying it is off to the
 * switch beside it. The key is never shown. The whole row is a link to the item's page.
 */
import { contextOff, type ContextRecord } from '@harness/core';
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { fullTime, relativeTime, UiBadge, UiIcon } from '../../ui/index.ts';
import { AUDIENCE_WORDS, contextLabel, DECLARED_WORDS, ORIGIN_WORDS, originOf, sizeText } from '../logic/context.ts';

const props = defineProps<{ record: ContextRecord; to: RouteLocationRaw; now: number; detailed?: boolean }>();
const label = computed(() => contextLabel(props.record.decl));
/** The description, under a title; a row without a title already reads as its description. */
const description = computed(() => (props.record.decl.title === undefined ? '' : props.record.decl.description));
const choices = computed(() => props.record.decl.choices?.length ?? 0);
const origin = computed(() => ORIGIN_WORDS[originOf(props.record)]);
const command = computed(() => props.record.decl.command?.name);
/** Where it was declared, on a system's page: its contract unless it says it was added while running. */
const declared = computed(() => DECLARED_WORDS[props.record.declaredBy ?? 'contract']);
/** Who sees it: on a system's page always said, elsewhere only when not everyone. */
/** Off by itself (a remembered item a person forgot reads as forgotten) or with all its system's context. */
const off = computed(() => contextOff(props.record));
const offWord = computed(() => (props.record.disabled === true ? (originOf(props.record) === 'memory' ? 'Forgotten' : 'Off') : 'System context off'));
const seenBy = computed(() => (props.detailed || props.record.decl.visible !== 'both' ? `Seen by ${AUDIENCE_WORDS[props.record.decl.visible].toLowerCase()}` : ''));
</script>

<template>
  <RouterLink class="row" :class="{ off, detailed }" :to="to" :data-context="record.name" data-testid="context-row">
    <span v-if="!detailed" class="mark" :data-origin="originOf(record)" aria-hidden="true"><UiIcon :name="origin.icon" :size="16" /></span>
    <span class="main">
      <span class="top">
        <span class="name">{{ label }}</span>
        <UiBadge v-if="command !== undefined">/{{ command }}</UiBadge>
        <UiBadge v-if="record.decl.alwaysFor.length > 0" tone="accent">Always given</UiBadge>
        <UiBadge v-if="seenBy !== ''" data-testid="context-seen-by">{{ seenBy }}</UiBadge>
        <UiBadge v-if="choices > 0">{{ choices }} {{ choices === 1 ? 'choice' : 'choices' }}</UiBadge>
        <UiBadge v-if="!detailed && record.declaredBy === 'runtime'" tone="accent" :title="record.version === undefined ? undefined : `Version ${record.version.slice(0, 8)}`" data-testid="context-runtime">Added while running</UiBadge>
        <UiBadge v-if="record.stale" tone="warn">Stale</UiBadge>
        <UiBadge v-if="off && !detailed" data-testid="context-off">{{ offWord }}</UiBadge>
      </span>
      <span v-if="description !== ''" class="description">{{ description }}</span>
    </span>
    <span class="side">
      <span v-if="detailed" class="origin" data-testid="context-declared">{{ declared }}<code v-if="record.version !== undefined" class="version" :title="`Version ${record.version}`">{{ record.version.slice(0, 8) }}</code></span>
      <span v-else class="origin">{{ origin.short }}</span>
      <span class="facts">
        <span v-if="sizeText(record) !== undefined" class="tokens">{{ sizeText(record) }}</span>
        <time class="when" :datetime="new Date(record.updatedAt).toISOString()" :title="fullTime(record.updatedAt)">{{ relativeTime(record.updatedAt, now) }}</time>
      </span>
    </span>
  </RouterLink>
</template>

<style scoped>
.row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none; transition: background var(--fast) var(--ease);
}
.row:hover { background: var(--surface-2); text-decoration: none; }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.off .name, .off .description { color: var(--text-faint); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.mark[data-origin='memory'] { background: var(--accent-soft); color: var(--accent); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.description { color: var(--text-dim); font-size: var(--text-sm); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.side { display: grid; justify-items: end; gap: 2px; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.origin { color: var(--text-dim); }
.version { margin-left: var(--space-2); color: var(--text-faint); font-size: var(--text-xs); }
/* size and time share one line, so every row with a one-line title is the same height */
.facts { display: flex; gap: var(--space-2); }
.facts > * + *::before { content: '·'; margin-right: var(--space-2); }
.row.detailed { grid-template-columns: minmax(0, 1fr) auto; }
@media (max-width: 559.98px) {
  .row { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .row.detailed { grid-template-columns: minmax(0, 1fr); }
  .side { grid-column: -2; display: flex; flex-wrap: wrap; justify-items: start; gap: var(--space-2); }
}
</style>
