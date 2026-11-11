<script setup lang="ts">
/**
 * One folder in the file explorer's tree: its twist, its name, and its subfolders once it is open (fetched the first
 * time). The folder shown in the list is marked. Where its subfolders come from is the caller's (`childrenOf`).
 */
import { computed } from 'vue';
import { UiIcon } from '../../ui/index.ts';
import type { ExploreChildren } from '../logic/explore.ts';

const props = defineProps<{
  uri: string;
  label: string;
  /** The folder shown in the list. */
  current: string;
  expanded: ReadonlySet<string>;
  childrenOf: (uri: string) => ExploreChildren;
}>();
const emit = defineEmits<{ toggle: [uri: string]; choose: [uri: string] }>();

const open = computed(() => props.expanded.has(props.uri));
const children = computed(() => (open.value ? props.childrenOf(props.uri) : undefined));
</script>

<template>
  <li class="explore-node">
    <div class="item">
      <button type="button" class="twist" :aria-expanded="open" :aria-label="`${open ? 'Close' : 'Open'} ${label}`" @click="emit('toggle', uri)">
        <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      </button>
      <button type="button" class="node" :class="{ chosen: current === uri }" :aria-current="current === uri ? 'true' : undefined" data-testid="explore-node" @click="emit('choose', uri)">
        <UiIcon name="folder" :size="16" /><span class="label" :title="label">{{ label }}</span>
      </button>
    </div>
    <ul v-if="children" class="level">
      <li v-if="children.loading && children.folders.length === 0" class="dim">Loading…</li>
      <li v-else-if="children.problem" class="dim">{{ children.problem }}</li>
      <ExploreNode
        v-for="child in children.folders" :key="child.uri" :uri="child.uri" :label="child.name" :current="current" :expanded="expanded" :children-of="childrenOf"
        @toggle="emit('toggle', $event)" @choose="emit('choose', $event)"
      />
    </ul>
  </li>
</template>

<style scoped>
.explore-node { min-width: 0; }
.level { display: grid; gap: 2px; margin: 0; padding: 0 0 0 var(--space-3); list-style: none; }
.item { display: flex; align-items: center; gap: 2px; min-width: 0; }
.twist { display: grid; place-items: center; width: 24px; height: 28px; flex: none; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--text-faint); cursor: pointer; }
.node { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; min-height: 32px; padding: 0 var(--space-2); border: 0; border-radius: 6px; background: none; color: var(--text-dim); font: inherit; text-align: left; cursor: pointer; }
.node:hover { background: var(--surface-2); color: var(--text); }
.node.chosen { background: color-mix(in oklab, var(--accent) 12%, transparent); color: var(--text); font-weight: var(--weight-medium); }
.node:focus-visible, .twist:focus-visible { outline: none; box-shadow: var(--ring); }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim { color: var(--text-faint); font-size: var(--text-xs); padding-left: var(--space-2); }
</style>
