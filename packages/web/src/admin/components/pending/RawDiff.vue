<script setup lang="ts">
/** A declaration before and after a change, as a line diff of its pretty JSON (removed lines red, added green). */
import type { Json } from '@harness/core';
import { computed } from 'vue';
import { lineDiff } from '../../logic/review.ts';

const props = defineProps<{ before: Json | undefined; after: Json | undefined }>();
const lines = computed(() => lineDiff(props.before, props.after));
const MARK = { same: ' ', add: '+', remove: '−' } as const;
</script>

<template>
  <pre class="diff" data-testid="review-diff"><span v-for="(line, index) in lines" :key="index" class="line" :class="line.kind">{{ MARK[line.kind] }} {{ line.text }}
</span></pre>
</template>

<style scoped>
.diff { margin: 0; padding: var(--space-2) 0; max-height: 420px; overflow: auto; border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-xs); }
.line { display: block; padding: 0 var(--space-3); white-space: pre-wrap; overflow-wrap: anywhere; }
.line.add { background: var(--ok-soft); }
.line.remove { background: var(--danger-soft); }
</style>
