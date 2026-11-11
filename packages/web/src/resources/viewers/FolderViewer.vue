<script setup lang="ts">
/**
 * A folder's or an archive's entries, from its links: each child opens in the viewer, folders first, then by name. A
 * child the system gave no address resolves against the folder's own (`linkTarget`), so every entry opens.
 */
import type { ResourceLink } from '@harness/core';
import { computed } from 'vue';
import { UiEmpty, UiIcon } from '../../ui/index.ts';
import { linkTarget } from '../logic/browse.ts';

const props = defineProps<{ links: readonly ResourceLink[]; /** The folder's own address. */ base: string }>();
const emit = defineEmits<{ open: [uri: string] }>();

/** The folder as a base address: children resolve inside it, so it ends with a slash. */
const base = computed(() => (props.base.endsWith('/') ? props.base : `${props.base}/`));
const entries = computed(() => props.links
  .filter((link) => link.kind === 'child')
  .map((link) => ({ link, target: linkTarget(link, base.value), name: link.title ?? link.raw, folder: link.raw.endsWith('/') || !/\.[^/]+$/.test(link.raw) }))
  .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true })));
</script>

<template>
  <div class="folder-viewer" data-testid="folder-view">
    <UiEmpty v-if="entries.length === 0" icon="folder" title="Nothing in here" body="This folder has no entries the hub knows of." />
    <ul v-else class="entries">
      <li v-for="entry in entries" :key="entry.link.raw">
        <button type="button" class="entry" :disabled="entry.target === undefined" data-testid="folder-entry" @click="entry.target && emit('open', entry.target)">
          <UiIcon :name="entry.folder ? 'folder' : 'file'" :size="16" />
          <span class="name">{{ entry.name }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.folder-viewer { min-width: 0; }
.entries { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.entry { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 36px; padding: 0 var(--space-2); border: 0; border-radius: 6px; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.entry:hover:not(:disabled) { background: var(--surface-2); }
.entry:disabled { color: var(--text-faint); cursor: default; }
.entry:focus-visible { outline: none; box-shadow: var(--ring); }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
