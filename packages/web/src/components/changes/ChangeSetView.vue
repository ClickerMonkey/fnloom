<script setup lang="ts">
/**
 * What a command changed: a tab per changed text file with its diff, then the files shown without one (binary,
 * large, sensitive, outside git) with why, and a note for what else the set says. It only draws what it is given.
 */
import type { ChangeSet } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiCodeBlock, UiTabs, type TabItem } from '../../ui/index.ts';
import { changeRows, changesNote, STATUS_WORDS } from './changes.ts';

const props = defineProps<{ changes: ChangeSet }>();

const rows = computed(() => changeRows(props.changes));
const diffed = computed(() => rows.value.filter((row) => row.diff !== undefined));
const plain = computed(() => rows.value.filter((row) => row.diff === undefined));
const tabs = computed<TabItem<string>[]>(() => diffed.value.map((row) => ({ value: row.key, label: row.name })));
const note = computed(() => changesNote(props.changes));

/** The file shown; the first with a diff until the person picks one. */
const chosen = ref('');
watch(diffed, (list) => {
  if (!list.some((row) => row.key === chosen.value)) { chosen.value = list[0]?.key ?? ''; }
}, { immediate: true });
const shown = computed(() => diffed.value.find((row) => row.key === chosen.value));
</script>

<template>
  <section class="changes" data-testid="change-set">
    <p v-if="rows.length === 0" class="dim">It changed no files.</p>
    <UiTabs v-if="tabs.length > 0" v-model="chosen" :tabs="tabs" label="Changed files">
      <div v-if="shown" class="file" data-testid="change-diff" :data-path="shown.change.path">
        <p class="file-line">
          <span class="status" :class="shown.change.status">{{ STATUS_WORDS[shown.change.status] }}</span>
          <code class="path">{{ shown.change.from === undefined ? shown.change.path : `${shown.change.from} → ${shown.change.path}` }}</code>
          <span v-if="shown.change.added !== undefined" class="added">+{{ shown.change.added }}</span>
          <span v-if="shown.change.removed !== undefined" class="removed">−{{ shown.change.removed }}</span>
          <span v-if="!shown.change.certain" class="maybe">maybe</span>
        </p>
        <UiCodeBlock :code="shown.diff ?? ''" language="diff" :max-height="480" />
      </div>
    </UiTabs>
    <ul v-if="plain.length > 0" class="plain" aria-label="Changed files without a diff">
      <li v-for="row in plain" :key="row.key" class="plain-row" data-testid="change-plain" :data-path="row.change.path">
        <span class="status" :class="row.change.status">{{ STATUS_WORDS[row.change.status] }}</span>
        <code class="path">{{ row.change.path }}</code>
        <span class="why">{{ row.why }}<template v-if="!row.change.certain"> · maybe</template></span>
      </li>
    </ul>
    <p v-if="note !== ''" class="dim note">{{ note }}</p>
  </section>
</template>

<style scoped>
.changes { display: grid; gap: var(--space-3); min-width: 0; }
.file { display: grid; gap: var(--space-2); min-width: 0; }
.file-line, .plain-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); min-width: 0; margin: 0; font-size: var(--text-sm); }
.path { min-width: 0; font-family: var(--mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
.status { font-size: var(--text-xs); font-weight: var(--weight-strong); color: var(--text-dim); }
.status.added { color: var(--ok); }
.status.deleted { color: var(--danger); }
.added { color: var(--ok); font-variant-numeric: tabular-nums; font-size: var(--text-xs); }
.removed { color: var(--danger); font-variant-numeric: tabular-nums; font-size: var(--text-xs); }
.maybe { padding: 0 var(--space-2); border-radius: var(--radius-sm); background: var(--warn-soft); font-size: var(--text-xs); }
.plain { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.why { color: var(--text-dim); font-size: var(--text-xs); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.note { font-size: var(--text-xs); }
</style>
