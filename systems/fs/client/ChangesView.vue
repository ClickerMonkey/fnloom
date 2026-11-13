<script setup lang="ts">
/**
 * A command's changes, under the bash card's output: a tab per changed text file with its diff, then the files listed
 * without one (binary, too large, sensitive, outside git) with why. Says when git ignored more, when the list is cut,
 * and when some changes may be another call's.
 */
import type { ChangeSet } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { changeTabs, changesSummary, STATUS_WORDS, uncertain, undiffed } from './changes.ts';
import DiffBody from './DiffBody.vue';

const props = defineProps<{ changes: ChangeSet }>();

const tabs = computed(() => changeTabs(props.changes));
const others = computed(() => undiffed(props.changes));
const summary = computed(() => changesSummary(props.changes));
const unsure = computed(() => uncertain(props.changes));

const chosen = ref<string | undefined>(undefined);
const current = computed(() => tabs.value.find((tab) => tab.key === chosen.value) ?? tabs.value[0]);
watch(tabs, (next) => { if (!next.some((tab) => tab.key === chosen.value)) { chosen.value = next[0]?.key; } }, { immediate: true });

const tabButtons = ref<HTMLButtonElement[]>([]);
/** Arrow keys move between tabs, as in any tab list. */
function step(by: number): void {
  const at = tabs.value.findIndex((tab) => tab.key === current.value?.key);
  const next = tabs.value[(at + by + tabs.value.length) % tabs.value.length];
  if (next === undefined) { return; }
  chosen.value = next.key;
  tabButtons.value[tabs.value.indexOf(next)]?.focus();
}
const id = (key: string) => `changes-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
</script>

<template>
  <section class="changes" aria-label="Files changed">
    <header class="head">
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12.5 5v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z" /><path d="M9 1.5V5h3.5" /></svg>
      <span class="summary">{{ summary }}</span>
      <span v-if="unsure" class="unsure" title="Another call worked in the same folder at the same time, so some of these may be its changes.">some may be another call's</span>
    </header>

    <template v-if="current">
      <div class="tabs" role="tablist" aria-label="Changed files" @keydown.right.prevent="step(1)" @keydown.left.prevent="step(-1)">
        <button
          v-for="tab in tabs" :id="`${id(tab.key)}-tab`" :key="tab.key" ref="tabButtons" type="button" role="tab" class="tab"
          :aria-selected="tab.key === current.key" :aria-controls="id(tab.key)" :tabindex="tab.key === current.key ? 0 : -1" :title="tab.file.path"
          @click="chosen = tab.key"
        >
          <span class="dot" :class="tab.file.status" aria-hidden="true" />
          <span class="name">{{ tab.name }}</span>
          <span class="stats"><span class="plus">+{{ tab.added }}</span><span class="minus">−{{ tab.removed }}</span></span>
        </button>
      </div>
      <div :id="id(current.key)" class="panel" role="tabpanel" :aria-labelledby="`${id(current.key)}-tab`">
        <p class="path">
          <span class="status">{{ STATUS_WORDS[current.file.status] }}</span>
          <span class="where" :title="current.file.path"><template v-if="current.file.from">{{ current.file.from }} → </template>{{ current.file.path }}</span>
        </p>
        <DiffBody v-if="current.blocks.length > 0" :blocks="current.blocks" :label="`Changes to ${current.file.path}`" />
        <p v-else class="empty">{{ current.file.status === 'renamed' ? 'Moved without changes.' : 'No line changes (mode or staging only).' }}</p>
      </div>
    </template>

    <ul v-if="others.length > 0" class="others" aria-label="Changed files without a diff">
      <li v-for="other in others" :key="other.key" class="other">
        <span class="dot" :class="other.file.status" aria-hidden="true" />
        <span class="where" :title="other.file.path">{{ other.file.path }}</span>
        <span class="status">{{ STATUS_WORDS[other.file.status] }}</span>
        <span class="why">{{ other.why }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.changes {
  display: grid;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
}
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--space-2); padding: var(--space-2) var(--space-3); font-size: var(--text-sm); }
.icon { width: 15px; height: 15px; flex: none; fill: none; stroke: var(--text-dim); stroke-width: 1.3; stroke-linejoin: round; }
.summary { font-weight: var(--weight-strong); }
.unsure { padding: 0 6px; border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); line-height: 18px; }
.tabs {
  display: flex;
  gap: 2px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: thin;
}
.tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 220px;
  min-height: var(--control-sm);
  padding: 0 var(--space-2);
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-dim);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}
.tab:hover { color: var(--text); }
.tab[aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.stats { display: inline-flex; gap: 3px; font: var(--text-xs)/1 var(--mono); }
.plus { color: var(--ok); }
.minus { color: var(--danger); }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); }
.dot.added { background: var(--ok); }
.dot.deleted { background: var(--danger); }
.dot.modified, .dot.renamed { background: var(--accent); }
.panel { display: grid; min-width: 0; }
.path { display: flex; gap: var(--space-2); align-items: baseline; min-width: 0; margin: 0; padding: var(--space-1) var(--space-3); font-size: var(--text-xs); }
.status { flex: none; color: var(--text-dim); }
.where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); direction: rtl; text-align: left; }
.empty { margin: 0; padding: var(--space-2) var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
.others { display: grid; gap: 2px; margin: 0; padding: var(--space-2) var(--space-3); list-style: none; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.other { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--space-2); min-width: 0; }
.other .where { flex: 1 1 12rem; }
.why { color: var(--text-dim); }
</style>
