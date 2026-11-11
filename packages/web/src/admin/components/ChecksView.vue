<script setup lang="ts">
/**
 * What was checked about a system's build before it ran: its own tests (the counts, then each failure with why, then
 * the rest), its component previews as a gallery of names (component, state, viewport and theme), and the scan of its
 * server bundle (its size, the Node built-ins it uses, lines of concern, and the hosts it names).
 */
import type { InstallChecks } from '@harness/core';
import { computed } from 'vue';
import { formatBytes, formatDuration } from '../../chat/logic/format.ts';
import { UiBadge, UiCard, UiEmpty } from '../../ui/index.ts';

const props = defineProps<{ checks: InstallChecks | undefined }>();
const tests = computed(() => props.checks?.tests);
const failed = computed(() => tests.value?.cases.filter((test) => test.status === 'failed') ?? []);
const others = computed(() => tests.value?.cases.filter((test) => test.status !== 'failed') ?? []);
</script>

<template>
  <UiCard v-if="checks === undefined" flat>
    <UiEmpty icon="shield" title="No checks" body="It paired without an install check (it wasn't installed through fs), so there is no scan or test result to show." />
  </UiCard>
  <div v-else class="checks" data-testid="review-checks">
    <UiCard title="Tests" :subtitle="tests ? `Ran ${formatDuration(tests.duration)} for version ${tests.version}` : 'It ships no tests'">
      <template v-if="tests">
        <div class="counts" data-testid="checks-counts">
          <UiBadge tone="ok">{{ tests.passed }} passed</UiBadge>
          <UiBadge :tone="tests.failed > 0 ? 'danger' : 'neutral'">{{ tests.failed }} failed</UiBadge>
          <UiBadge>{{ tests.skipped }} skipped</UiBadge>
        </div>
        <ul v-if="tests.cases.length > 0" class="cases">
          <li v-for="test in [...failed, ...others]" :key="`${test.file}:${test.name}`" :class="test.status" data-testid="checks-case">
            <span class="case-head">
              <UiBadge :tone="test.status === 'failed' ? 'danger' : test.status === 'passed' ? 'ok' : 'neutral'">{{ test.status }}</UiBadge>
              <span class="case-name">{{ test.name }}</span>
              <UiBadge v-if="test.real" tone="accent">Real model</UiBadge>
              <span class="file">{{ test.file }}</span>
            </span>
            <pre v-if="test.error" class="error">{{ test.error }}</pre>
          </li>
        </ul>
        <p v-if="(tests.more ?? 0) > 0" class="dim">And {{ tests.more }} more.</p>
      </template>
    </UiCard>
    <UiCard v-if="(tests?.previews?.length ?? 0) > 0" title="Component previews" subtitle="Each component in its named states, on a phone and a desktop, light and dark.">
      <ul class="gallery" data-testid="checks-previews">
        <li v-for="shot in tests?.previews ?? []" :key="`${shot.component}:${shot.state}:${shot.viewport}:${shot.theme}`" class="shot">
          <span class="shot-name">{{ shot.component }}</span>
          <span class="dim">{{ shot.state }} · {{ shot.viewport }} · {{ shot.theme }}</span>
        </li>
      </ul>
    </UiCard>
    <UiCard title="Bundle scan" :subtitle="formatBytes(checks.scan.size)">
      <dl class="scan">
        <div><dt>Node built-ins</dt><dd><code v-for="name in checks.scan.builtins" :key="name">{{ name }}</code><span v-if="checks.scan.builtins.length === 0" class="dim">None</span></dd></div>
        <div><dt>Hosts it names</dt><dd><code v-for="host in checks.scan.hosts" :key="host">{{ host }}</code><span v-if="checks.scan.hosts.length === 0" class="dim">None</span></dd></div>
      </dl>
      <ul v-if="checks.scan.concerns.length > 0" class="concerns" data-testid="checks-concerns">
        <li v-for="concern in checks.scan.concerns" :key="`${concern.kind}:${concern.line}`">
          <span class="case-head"><UiBadge tone="warn">{{ concern.kind }}</UiBadge><span>{{ concern.detail }}</span><span class="file">line {{ concern.line }}</span></span>
          <pre class="error">{{ concern.code }}</pre>
        </li>
      </ul>
      <p v-else class="dim">Nothing of concern.</p>
    </UiCard>
  </div>
</template>

<style scoped>
.checks { display: grid; gap: var(--space-4); }
.counts { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); }
.cases, .concerns { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.case-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.case-name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.file { color: var(--text-faint); font-size: var(--text-xs); }
.error { margin: var(--space-1) 0 0; padding: var(--space-2); border-radius: var(--radius-sm); background: var(--surface-2); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.shot { display: grid; gap: 2px; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); font-size: var(--text-sm); }
.shot-name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.scan { display: grid; gap: var(--space-2); margin: 0 0 var(--space-3); }
.scan dt { color: var(--text-faint); font-size: var(--text-xs); }
.scan dd { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; font-size: var(--text-sm); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
