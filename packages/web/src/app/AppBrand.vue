<script setup lang="ts">
/** The hub's mark (a hub with three connected systems) and, unless `markOnly`, its display name. */
withDefaults(defineProps<{
  /** The hub's display name (`IdentityStore.name`). */
  name: string;
  markOnly?: boolean;
  size?: number;
}>(), { markOnly: false, size: 28 });
</script>

<template>
  <span class="brand" :title="markOnly ? name : undefined">
    <svg class="mark" :width="size" :height="size" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" class="tile" />
      <g class="lines" stroke-width="2" stroke-linecap="round">
        <path d="M16 16 9 9M16 16l7-7M16 16v8" />
      </g>
      <circle cx="16" cy="16" r="3.5" class="hub" />
      <circle cx="9" cy="9" r="2.3" class="node" />
      <circle cx="23" cy="9" r="2.3" class="node" />
      <circle cx="16" cy="24" r="2.3" class="node" />
    </svg>
    <span v-if="!markOnly" class="name" data-testid="brand-name">{{ name }}</span>
  </span>
</template>

<style scoped>
.brand { display: inline-flex; align-items: center; gap: var(--space-2); min-width: 0; }
.mark { flex: none; }
.tile { fill: var(--accent); }
.lines { stroke: var(--on-accent); opacity: 0.7; }
.hub, .node { fill: var(--on-accent); }
.name { overflow: hidden; text-overflow: ellipsis; font-weight: var(--weight-strong); font-size: var(--text-lg); letter-spacing: -0.02em; white-space: nowrap; }
</style>
