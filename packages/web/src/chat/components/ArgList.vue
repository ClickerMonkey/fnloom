<script setup lang="ts">
/**
 * A call's args in readable form, as approvals and questions show them: each field's name and value, long values
 * clamped behind Show more. A value that isn't an object shows as one `value` row.
 */
import type { Json } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { clamp } from '../logic/format.ts';
import { humanize } from '../logic/labels.ts';

const props = withDefaults(defineProps<{ args: Json | undefined; max?: number }>(), { max: 280 });

const expanded = ref<ReadonlySet<string>>(new Set());
watch(() => props.args, () => { expanded.value = new Set(); });

const rows = computed(() => {
  const value = props.args;
  if (value === undefined || value === null) { return []; }
  const entries: [string, Json][] = typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [['value', value]];
  return entries.map(([key, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return { key, label: humanize(key), text, long: text.length > props.max, short: clamp(text, props.max) };
  });
});

function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) { next.delete(key); } else { next.add(key); }
  expanded.value = next;
}
</script>

<template>
  <dl v-if="rows.length > 0" class="args" data-testid="arg-list">
    <template v-for="row in rows" :key="row.key">
      <dt>{{ row.label }}</dt>
      <dd>
        <pre class="value">{{ expanded.has(row.key) ? row.text : row.short }}</pre>
        <button v-if="row.long" type="button" class="more" @click="toggle(row.key)">{{ expanded.has(row.key) ? 'Show less' : 'Show more' }}</button>
      </dd>
    </template>
  </dl>
</template>

<style scoped>
.args { display: grid; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); gap: var(--space-1) var(--space-3); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-faint); padding-top: 2px; }
dd { display: grid; justify-items: start; gap: 2px; margin: 0; min-width: 0; }
.value { margin: 0; max-width: 100%; font-family: var(--mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.more { padding: 0; border: 0; background: transparent; color: var(--accent); font-size: var(--text-xs); }
@media (max-width: 480px) { .args { grid-template-columns: minmax(0, 1fr); } dt { padding-top: var(--space-1); } }
</style>
