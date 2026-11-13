<script setup lang="ts">
/**
 * An item's version history (build 8), folded under one line until opened: then its versions, newest first, each with
 * its number, what changed, where it came from (the contract or added while running), who saved it and when; opening a
 * version shows its declaration. Older versions load a page at a time. Drawn only where the app provides the history.
 */
import { inject, ref, watch } from 'vue';
import { DECLARED_WORDS } from '../../context/logic/context.ts';
import { UiButton, UiCodeBlock, UiIcon, fullTime, relativeTime } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import { ITEM_CHANGE_WORDS, ITEM_VERSIONS, ItemHistory, type ItemKey } from './versions.ts';

const props = defineProps<{ item: ItemKey }>();
const source = inject(ITEM_VERSIONS, undefined);
const history = source === undefined ? undefined : new ItemHistory(source);
const now = useNow();
const open = ref(false);
const shown = ref<string | undefined>(undefined);

function toggle(): void {
  open.value = !open.value;
  if (open.value && history !== undefined && !history.loaded.value) { void history.load(props.item); }
}
watch(() => JSON.stringify(props.item), () => {
  shown.value = undefined;
  if (open.value) { void history?.load(props.item); } else if (history !== undefined) { history.loaded.value = false; }
});
</script>

<template>
  <section v-if="history" class="history" data-testid="item-history" :data-item="`${item.section}:${item.name}`">
    <button type="button" class="toggle" :aria-expanded="open" data-testid="item-history-toggle" @click="toggle">
      <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      <span>History</span>
      <span v-if="history.loaded.value" class="count">{{ history.versions.value.length }}{{ history.next.value !== undefined ? '+' : '' }} {{ history.versions.value.length === 1 ? 'version' : 'versions' }}</span>
    </button>
    <template v-if="open">
      <p v-if="history.problem.value !== ''" class="problem">{{ history.problem.value }} <UiButton size="sm" variant="ghost" @click="history.load(item)">Retry</UiButton></p>
      <p v-else-if="history.loaded.value && history.versions.value.length === 0" class="none">No versions kept yet.</p>
      <ol v-if="history.versions.value.length > 0" class="list">
        <li v-for="version in history.versions.value" :key="version.id" :data-version="version.number">
          <button type="button" class="row" :aria-expanded="shown === version.id" data-testid="item-version" @click="shown = shown === version.id ? undefined : version.id">
            <span class="number">#{{ version.number }}</span>
            <span class="change" :class="version.change">{{ ITEM_CHANGE_WORDS[version.change] }}</span>
            <span class="meta">
              <span v-if="version.declaredBy">{{ DECLARED_WORDS[version.declaredBy] }}</span>
              <span v-if="version.instance">@{{ version.instance }}</span>
              <span v-if="version.savedBy">by {{ version.savedBy }}</span>
              <time :datetime="new Date(version.savedAt).toISOString()" :title="fullTime(version.savedAt)">{{ relativeTime(version.savedAt, now) }}</time>
            </span>
          </button>
          <UiCodeBlock v-if="shown === version.id" :code="JSON.stringify(version.decl, null, 2)" language="json" :max-height="320" wrap />
        </li>
      </ol>
      <UiButton v-if="history.next.value !== undefined" size="sm" variant="ghost" :loading="history.loading.value" @click="history.more()">Older versions</UiButton>
    </template>
  </section>
</template>

<style scoped>
.history { display: grid; gap: var(--space-2); min-width: 0; }
.toggle {
  display: inline-flex; align-items: center; gap: var(--space-1); justify-self: start; padding: 2px var(--space-1); border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-dim); font: inherit; font-size: var(--text-sm); cursor: pointer;
}
.toggle:hover { color: var(--text); }
.toggle:focus-visible { outline: none; box-shadow: var(--ring); }
.count { color: var(--text-faint); font-size: var(--text-xs); }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.list > li { display: grid; gap: var(--space-2); min-width: 0; }
.list > li > :deep(.code-block), .list > li > :not(.row) { margin: 0 var(--space-3) var(--space-3); }
.row {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); width: 100%; padding: var(--space-2) var(--space-3);
  border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer;
}
.row:hover { background: var(--surface-2); }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.number { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--text-dim); }
.change { font-weight: var(--weight-medium); }
.change.removed { color: var(--danger); }
.meta { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-left: auto; color: var(--text-faint); font-size: var(--text-xs); }
.problem, .none { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.problem { color: var(--danger); }
</style>
