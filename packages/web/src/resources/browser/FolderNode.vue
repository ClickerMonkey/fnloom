<script setup lang="ts">
/** One folder in the folder tree: its twist, its name and count, and its subfolders once it is open. */
import type { ResourceFacet } from '@harness/core';
import { computed } from 'vue';
import type { Loaded } from '../../state/loaded.ts';
import { UiIcon } from '../../ui/index.ts';

const props = defineProps<{
  folder: ResourceFacet;
  folders: ReadonlyMap<string, Loaded<readonly ResourceFacet[]>>;
  under: string;
  expanded: ReadonlySet<string>;
}>();
const emit = defineEmits<{ toggle: [value: string]; choose: [value: string] }>();

const open = computed(() => props.expanded.has(props.folder.value));
const loaded = computed(() => props.folders.get(props.folder.value));
const children = computed(() => loaded.value?.value.value ?? []);
</script>

<template>
  <li class="folder-node">
    <div class="item">
      <button type="button" class="twist" :aria-expanded="open" :aria-label="`${open ? 'Close' : 'Open'} ${folder.label}`" @click="emit('toggle', folder.value)">
        <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      </button>
      <button type="button" class="node" :class="{ chosen: under === folder.value }" :aria-current="under === folder.value ? 'true' : undefined" data-testid="folder-node" @click="emit('choose', folder.value)">
        <UiIcon name="folder" :size="16" /><span class="label">{{ folder.label }}</span><span class="count">{{ folder.count.toLocaleString() }}</span>
      </button>
    </div>
    <ul v-if="open" class="level">
      <li v-if="loaded?.loading.value && children.length === 0" class="dim">Loading…</li>
      <li v-else-if="loaded?.problem.value" class="dim">{{ loaded.problem.value }}</li>
      <FolderNode
        v-for="child in children" :key="child.value" :folder="child" :folders="folders" :under="under" :expanded="expanded"
        @toggle="emit('toggle', $event)" @choose="emit('choose', $event)"
      />
    </ul>
  </li>
</template>

<style scoped>
.folder-node { min-width: 0; }
.level { display: grid; gap: 2px; margin: 0; padding: 0 0 0 var(--space-3); list-style: none; }
.item { display: flex; align-items: center; gap: 2px; min-width: 0; }
.twist { display: grid; place-items: center; width: 24px; height: 28px; flex: none; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--text-faint); cursor: pointer; }
.node { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; min-height: 32px; padding: 0 var(--space-2); border: 0; border-radius: 6px; background: none; color: var(--text-dim); font: inherit; text-align: left; cursor: pointer; }
.node:hover { background: var(--surface-2); color: var(--text); }
.node.chosen { background: color-mix(in oklab, var(--accent) 12%, transparent); color: var(--text); font-weight: var(--weight-medium); }
.node:focus-visible, .twist:focus-visible { outline: none; box-shadow: var(--ring); }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.dim { color: var(--text-faint); font-size: var(--text-xs); padding-left: var(--space-2); }
</style>
