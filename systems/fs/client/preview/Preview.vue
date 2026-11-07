<script setup lang="ts">
/**
 * Every fs renderer in the states that matter, on the chat's theme, for the screenshot check (`npm run preview:shots
 * -w @harness/system-fs`). The `?only=` query shows one section so each can be shot on its own.
 */
import { mintId } from '@harness/core';
import { computed, ref } from 'vue';
import type { EntryValue } from '../../shared/index.ts';
import BashView from '../BashView.vue';
import DiffView from '../DiffView.vue';
import EntryInput from '../EntryInput.vue';
import { fakeFsSystem } from '../fakes.ts';

const online = fakeFsSystem(true);
const offline = fakeFsSystem(false);
const run = mintId('run');
const tests = Array.from({ length: 40 }, (_, i) => `  ✓ systems/fs/server/case-${i + 1}.test.ts (${(i * 7) % 23} tests) ${12 + i}ms`).join('\n');
const before = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i}; // a fairly long comment so the line runs past a phone's width for sure`).join('\n');
const after = before.replace('value3 = 3', 'value3 = 33').replace('value30 = 30;', 'value30 = 300;\nexport const added = true;');
const entry = ref<EntryValue | undefined>({ path: 'C:/Users/pdiff/Documents/GitHub/harness/docs/harness.md', type: 'file', size: 28_430, modifiedAt: new Date(Date.UTC(2026, 10, 7, 9, 30)) });
const blank = ref<EntryValue | undefined>();

const only = new URLSearchParams(location.search).get('only');
const show = (name: string) => computed(() => only === null || only === name);
const bash = show('bash');
const diff = show('diff');
const input = show('input');
</script>

<template>
  <main class="preview">
    <section v-if="bash" class="group" aria-label="Bash">
      <h2>Bash</h2>
      <BashView
        :run="run" status="running" :args="{ command: 'npm test -- --reporter=verbose systems/fs' }" :state="{ cwd: 'C:/Users/pdiff/Documents/GitHub/harness' }"
        :progress="{ fraction: 0.42, message: '✓ systems/fs/server/files.test.ts (11 tests) 54ms' }" :submit="undefined" :system="online.system"
      />
      <BashView
        :run="run" status="done" :args="{ command: 'npm test' }" :state="{ cwd: 'C:/Users/pdiff/Documents/GitHub/harness' }"
        :result="{ exitCode: 0, stdout: tests, stderr: '' }" :submit="undefined" :system="online.system"
      />
      <BashView
        :run="run" status="done" :args="{ command: 'git push origin harness --force-with-lease && echo done-with-a-very-long-command-line-that-wraps' }" :state="{}"
        :result="{ exitCode: 1, stdout: '', stderr: 'error: failed to push some refs to origin\nhint: Updates were rejected because the remote contains work' }" :submit="undefined" :system="offline.system"
      />
      <BashView
        :run="run" status="failed" :args="{ command: 'npm run dev', cwd: 'C:/work' }" :state="{}"
        :error="{ class: 'caller', code: 'timeout', message: 'The command didn\'t finish within 120000 ms, so it was stopped.', data: { exitCode: 124, stdout: 'hub listening on 4300\n', stderr: '' } }"
        :submit="undefined" :system="online.system"
      />
    </section>
    <section v-if="diff" class="group" aria-label="Diff">
      <h2>Diff</h2>
      <DiffView :data="{ path: 'C:/Users/pdiff/Documents/GitHub/harness/systems/fs/server/values.ts', before, after }" title="Edited server/values.ts" :system="online.system" />
      <DiffView :data="{ path: 'docs/notes.md', before: '', after: '# Notes\n\n- one\n- two\n' }" title="Created docs/notes.md" :system="online.system" />
    </section>
    <section v-if="input" class="group" aria-label="Entry input">
      <h2>Entry input</h2>
      <EntryInput v-model="entry" :problems="[]" :system="online.system" />
      <EntryInput v-model="blank" :problems="['path: must not be empty']" :system="online.system" />
    </section>
  </main>
</template>

<style scoped>
.preview { display: grid; gap: var(--space-6); max-width: 760px; margin: 0 auto; padding: var(--space-5) var(--space-4); }
.group { display: grid; gap: var(--space-3); min-width: 0; }
h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-dim); }
</style>
