<script setup lang="ts">
/**
 * The sensitive files a call would touch (the preview's `flags` part): each file with what the call does to it, what
 * kind of file it is and why it is guarded. Approving lets this one call go ahead; it is asked about every time.
 * `compact` (the chat's tray) keeps every file in sight in short form: one line each, what it does, the path and the
 * kind, without the reasons (Review shows them).
 */
import type { SensitivityFlag } from '@harness/core';
import { computed } from 'vue';
import { UiIcon } from '../../ui/index.ts';
import { flagRows, flagsHeading } from './flags.ts';

const props = withDefaults(defineProps<{ flags: readonly SensitivityFlag[]; compact?: boolean }>(), { compact: false });
const rows = computed(() => flagRows(props.flags));
</script>

<template>
  <section class="sensitive" :class="{ compact }" data-testid="sensitive-files">
    <h4 class="heading"><UiIcon name="key" :size="14" />{{ flagsHeading(rows) }}</h4>
    <ul class="rows">
      <li v-for="row in rows" :key="row.key" class="row" :class="{ write: row.write }" data-testid="sensitive-file">
        <span class="verb">{{ row.verb }}</span>
        <code class="path" :title="row.path">{{ row.path }}</code>
        <span class="kind">{{ row.kind }}</span>
        <span v-if="!compact" class="why">{{ row.why }}</span>
      </li>
    </ul>
    <p v-if="!compact" class="note">Approving lets this call go ahead once. It is asked about every time.</p>
  </section>
</template>

<style scoped>
.sensitive { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3); border: 1px solid var(--warn-soft); border-radius: var(--radius); background: var(--surface-2); }
.heading { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--warn); font-size: var(--text-sm); font-weight: var(--weight-strong); }
.rows { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline; column-gap: var(--space-2); row-gap: 2px; min-width: 0; font-size: var(--text-sm); }
.verb { font-weight: var(--weight-strong); white-space: nowrap; }
.row.write .verb { color: var(--danger); }
.path { min-width: 0; font-family: var(--mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
.kind { padding: 0 var(--space-2); border-radius: var(--radius-sm); background: var(--warn-soft); color: var(--text); font-size: var(--text-xs); white-space: nowrap; }
.why { grid-column: 2 / -1; color: var(--text-dim); font-size: var(--text-xs); }
.compact { gap: var(--space-1); padding: var(--space-2) var(--space-3); }
.compact .rows { gap: 2px; }
.compact .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
</style>
