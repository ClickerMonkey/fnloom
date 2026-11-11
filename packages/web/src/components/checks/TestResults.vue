<script setup lang="ts">
/**
 * A system's own test results: the counts, then each failed test with why, then the rest (or, with `failuresOnly`, the
 * failures alone, for the install card), with the tests that call a real model marked.
 */
import type { SystemTestReport } from '@harness/core';
import { computed } from 'vue';
import { UiBadge } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ tests: SystemTestReport; failuresOnly?: boolean }>(), { failuresOnly: false });
const failed = computed(() => props.tests.cases.filter((test) => test.status === 'failed'));
const listed = computed(() => (props.failuresOnly ? failed.value : [...failed.value, ...props.tests.cases.filter((test) => test.status !== 'failed')]));
</script>

<template>
  <div class="results">
    <div class="counts" data-testid="checks-counts">
      <UiBadge tone="ok">{{ tests.passed }} passed</UiBadge>
      <UiBadge :tone="tests.failed > 0 ? 'danger' : 'neutral'">{{ tests.failed }} failed</UiBadge>
      <UiBadge>{{ tests.skipped }} skipped</UiBadge>
    </div>
    <ul v-if="listed.length > 0" class="cases">
      <li v-for="test in listed" :key="`${test.file}:${test.name}`" data-testid="checks-case">
        <span class="case-head">
          <UiBadge :tone="test.status === 'failed' ? 'danger' : test.status === 'passed' ? 'ok' : 'neutral'">{{ test.status }}</UiBadge>
          <span class="case-name">{{ test.name }}</span>
          <UiBadge v-if="test.real" tone="accent">Real model</UiBadge>
          <span class="file">{{ test.file }}</span>
        </span>
        <pre v-if="test.error" class="error">{{ test.error }}</pre>
      </li>
    </ul>
    <p v-if="!failuresOnly && (tests.more ?? 0) > 0" class="dim">And {{ tests.more }} more.</p>
  </div>
</template>

<style scoped>
.results { display: grid; gap: var(--space-3); min-width: 0; }
.counts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.cases { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.case-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.case-name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.file { color: var(--text-faint); font-size: var(--text-xs); }
.error { margin: var(--space-1) 0 0; padding: var(--space-2); border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
