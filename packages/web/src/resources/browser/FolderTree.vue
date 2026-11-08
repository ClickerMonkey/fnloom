<script setup lang="ts">
/**
 * The folder tree: every resource, then the roots, and each folder's subfolders as it opens (from the hub's `path`
 * facets, with how many resources each holds). Choosing a folder narrows the browser to it; the chosen one is
 * marked. Which folders are open is this tree's own; the chosen one is the page's (in the URL).
 */
import type { ResourceFacet } from '@harness/core';
import { computed, ref } from 'vue';
import type { Loaded } from '../../state/loaded.ts';
import { UiIcon, UiSpinner } from '../../ui/index.ts';
import FolderNode from './FolderNode.vue';

const props = defineProps<{
  folders: ReadonlyMap<string, Loaded<readonly ResourceFacet[]>>;
  /** The chosen folder ('' for every resource). */
  under: string;
}>();
const emit = defineEmits<{ open: [under: string]; choose: [under: string] }>();

const expanded = ref<ReadonlySet<string>>(new Set());
function toggle(value: string): void {
  const next = new Set(expanded.value);
  if (next.has(value)) { next.delete(value); } else { next.add(value); emit('open', value); }
  expanded.value = next;
}
const roots = computed(() => props.folders.get(''));
</script>

<template>
  <nav class="folder-tree" aria-label="Folders" data-testid="folder-tree">
    <button type="button" class="all" :class="{ chosen: under === '' }" :aria-current="under === '' ? 'true' : undefined" @click="emit('choose', '')">
      <UiIcon name="layers" :size="16" /><span>All resources</span>
    </button>
    <UiSpinner v-if="roots?.loading.value && !roots.value.value" :size="14" />
    <p v-else-if="roots?.problem.value" class="dim">{{ roots.problem.value }}</p>
    <ul class="roots">
      <FolderNode
        v-for="folder in roots?.value.value ?? []" :key="folder.value" :folder="folder" :folders="folders" :under="under" :expanded="expanded"
        @toggle="toggle" @choose="emit('choose', $event)"
      />
    </ul>
  </nav>
</template>

<style scoped>
.folder-tree { display: grid; gap: 2px; min-width: 0; font-size: var(--text-sm); }
.roots { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.all { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-2); border: 0; border-radius: 6px; background: none; color: var(--text-dim); font: inherit; text-align: left; cursor: pointer; }
.all:hover { background: var(--surface-2); color: var(--text); }
.all.chosen { background: color-mix(in oklab, var(--accent) 12%, transparent); color: var(--text); font-weight: var(--weight-medium); }
.all:focus-visible { outline: none; box-shadow: var(--ring); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
