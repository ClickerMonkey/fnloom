<script setup lang="ts">
/**
 * A folder's entries in the file explorer: folders first, then files, each with its type's icon, its name, its size and
 * when it changed. A press anywhere on a row opens it (a folder goes into it, a file opens beside the list); the opened
 * file is marked.
 */
import type { ResourceStat } from '@harness/core';
import { computed } from 'vue';
import { formatBytes } from '../../chat/logic/format.ts';
import { UiIcon, relativeTime } from '../../ui/index.ts';
import { sortEntries } from '../logic/explore.ts';
import { FAMILY_ICON, familyOfStat } from '../logic/formats.ts';

const props = withDefaults(defineProps<{ entries: readonly ResourceStat[]; now: number; opened?: string }>(), { opened: '' });
const emit = defineEmits<{ open: [entry: ResourceStat] }>();

const sorted = computed(() => sortEntries(props.entries));
</script>

<template>
  <ul class="entries" aria-label="Files" data-testid="explore-entries">
    <li v-for="entry in sorted" :key="entry.uri" class="row" :class="{ opened: opened === entry.uri }" data-testid="explore-entry" :data-type="entry.type">
      <UiIcon class="icon" :name="FAMILY_ICON[familyOfStat(entry)]" :size="18" />
      <button type="button" class="open" :aria-current="opened === entry.uri ? 'true' : undefined" @click="emit('open', entry)">
        <span class="name">{{ entry.name }}</span>
      </button>
      <span class="size">{{ entry.type === 'folder' || entry.size === undefined ? '' : formatBytes(entry.size) }}</span>
      <span class="time">{{ entry.modifiedAt === undefined ? '' : relativeTime(entry.modifiedAt, now) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.entries { margin: 0; padding: 0; list-style: none; container: entries / inline-size; }
.row { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr) 84px 96px; align-items: center; gap: var(--space-2); min-height: 44px; padding: 0 var(--space-2); border-bottom: 1px solid var(--border); cursor: pointer; }
.row:hover { background: var(--surface-2); }
.row.opened { background: color-mix(in oklab, var(--accent) 10%, transparent); }
.icon { color: var(--text-dim); }
.open { min-width: 0; padding: var(--space-2) 0; border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
/* the name's button covers the row, so a press anywhere on it opens the entry */
.open::after { content: ''; position: absolute; inset: 0; }
.open:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 6px; }
.name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size, .time { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; text-align: right; }
@container entries (max-width: 420px) {
  .row { grid-template-columns: 24px minmax(0, 1fr) auto; }
  .time { display: none; }
}
</style>
