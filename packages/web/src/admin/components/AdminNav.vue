<script setup lang="ts">
/**
 * The admin area's sections as a strip of links, a link a group: the open group shows each of its sections, so the
 * strip stays short at any width. It scrolls sideways when it still doesn't fit (phones), fading at an end with more
 * beyond it, and keeps the current section in view.
 */
import { nextTick, onMounted, ref, watch } from 'vue';
import { UiIcon, countLabel, useMoreEdges } from '../../ui/index.ts';
import type { AdminNavGroup } from '../logic/nav.ts';

const props = defineProps<{ groups: readonly AdminNavGroup[] }>();
const list = ref<HTMLElement | null>(null);
const edges = useMoreEdges(list);

/** Whether a group shows its sections: it is open and has more than one. */
const opened = (group: AdminNavGroup): boolean => group.active && group.entries.length > 1;

function reveal(): void {
  void nextTick(() => { list.value?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
}
onMounted(reveal);
watch(() => props.groups.flatMap((g) => g.entries).find((e) => e.active)?.id, reveal);
</script>

<template>
  <nav class="admin-nav" aria-label="Admin">
    <ul ref="list" class="strip edge-fade" :data-more="edges">
      <li v-for="group in groups" :key="group.id" :class="{ cluster: opened(group) }" :data-group="group.id">
        <template v-if="opened(group)">
          <RouterLink
            v-for="(entry, at) in group.entries" :key="entry.id" :to="entry.to" class="link" :class="{ active: entry.active }"
            :aria-current="entry.active ? 'page' : undefined" :data-testid="`admin-nav-${entry.id}`"
          >
            <UiIcon v-if="at === 0" :name="group.icon" :size="16" />
            <span>{{ entry.label }}</span>
            <span v-if="entry.count > 0" class="count" :aria-label="`${entry.count} waiting`">{{ countLabel(entry.count) }}</span>
          </RouterLink>
        </template>
        <RouterLink
          v-else :to="group.to" class="link" :class="{ active: group.active }" :aria-current="group.active ? 'page' : undefined"
          :data-testid="group.entries.length === 1 ? `admin-nav-${group.entries[0]?.id}` : `admin-nav-group-${group.id}`"
        >
          <UiIcon :name="group.icon" :size="16" />
          <span>{{ group.entries.length === 1 ? group.entries[0]?.label : group.label }}</span>
          <span v-if="group.count > 0" class="count" :aria-label="`${group.count} waiting`">{{ countLabel(group.count) }}</span>
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.admin-nav { position: sticky; top: 0; z-index: 5; min-width: 0; border-bottom: 1px solid var(--border); background: var(--bg); }
.strip {
  display: flex; align-items: center; gap: var(--space-1); margin: 0 auto; padding: var(--space-2) var(--space-5); max-width: var(--content); list-style: none;
  overflow-x: auto; scrollbar-width: none; scroll-padding-inline: var(--space-5);
}
.strip::-webkit-scrollbar { display: none; }
.cluster { display: flex; flex: none; gap: 2px; padding: 0 2px; border-radius: var(--radius-full); background: var(--surface-2); }
.link {
  display: inline-flex; align-items: center; gap: var(--space-2); height: var(--control-sm); padding: 0 var(--space-3); border-radius: var(--radius-full);
  color: var(--text-dim); font-size: var(--text-sm); font-weight: var(--weight-medium); white-space: nowrap; text-decoration: none;
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease);
}
.cluster .link { height: calc(var(--control-sm) - 4px); }
.link:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.cluster .link:hover { background: var(--surface); }
.link.active { background: var(--accent-soft); color: var(--text); }
.link.active :deep(.ui-icon) { color: var(--accent); }
.cluster .link :deep(.ui-icon) { color: var(--accent); }
.link:focus-visible { outline: none; box-shadow: var(--ring); }
.count { min-width: 18px; padding: 0 5px; border-radius: var(--radius-full); background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: var(--weight-strong); line-height: 18px; text-align: center; }
@media (max-width: 759.98px) { .strip { padding-inline: var(--space-4); } }
</style>
