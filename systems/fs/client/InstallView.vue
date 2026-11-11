<script setup lang="ts">
/**
 * The `install_system` card: while it builds, waits for its approval and starts, where it is and what it installs; once
 * done, the system and version that started, whether it is connected or waits for its config, the fns it brought
 * (which the agent loads to call them) and a link to its page, where its config is set. A failed install says why.
 */
import type { FnViewOf } from '@harness/sdk';
import { computed } from 'vue';
import type { fs } from '../shared/index.ts';

const view = defineProps<FnViewOf<typeof fs, 'install_system'>>();

/** The local part of a qualified fn name (`random/roll` is `roll`). */
const localOf = (fn: string): string => fn.slice(fn.indexOf('/') + 1);
const result = computed(() => view.result);
/** The system's admin page (an instance's own page when it isn't `main`). */
const page = computed(() => {
  const done = result.value;
  if (done === undefined) { return undefined; }
  const name = encodeURIComponent(done.system);
  return done.instance === 'main' ? `/admin/systems/${name}` : `/admin/systems/${name}/instances/${encodeURIComponent(done.instance)}`;
});
const state = computed(() => {
  if (result.value !== undefined) { return result.value.status === 'connected' ? { tone: 'good', label: 'Connected' } : { tone: 'warn', label: 'Needs its config' }; }
  if (view.error !== undefined) { return { tone: 'bad', label: 'Not installed' }; }
  if (view.status === 'awaiting-approval') { return { tone: 'warn', label: 'Waiting for an admin' }; }
  return { tone: 'busy', label: 'Building and starting' };
});
</script>

<template>
  <article class="install" :data-tone="state.tone" data-testid="install-card">
    <header class="head">
      <span class="what">
        <template v-if="result"><strong>{{ result.system }}</strong><span v-if="result.instance !== 'main'">@{{ result.instance }}</span> {{ result.version }}</template>
        <template v-else>Install <code>{{ view.args.path }}</code></template>
      </span>
      <span class="chip" :class="state.tone" role="status"><span class="dot" aria-hidden="true" />{{ state.label }}</span>
    </header>
    <p v-if="result" class="where" :title="result.folder">from {{ result.folder }}</p>
    <p v-if="result?.status === 'needs-config'" class="hint">It runs, but waits for its config: set it on its page, or give it here.</p>
    <ul v-if="result && result.fns.length > 0" class="fns" :aria-label="`${result.fns.length} fns`">
      <li v-for="name in result.fns" :key="name" :title="name"><code>{{ localOf(name) }}</code></li>
    </ul>
    <p v-if="view.error" class="problem">{{ view.error.message }}</p>
    <footer v-if="page" class="actions">
      <a class="link" :href="page" data-testid="install-open">Open its page</a>
    </footer>
  </article>
</template>

<style scoped>
.install { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.install[data-tone='bad'] { border-color: color-mix(in oklab, var(--danger) 35%, var(--border)); }
.head { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.what { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: var(--text-sm); }
.what code, .fns code { font: var(--text-xs) var(--mono); }
.chip { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); padding: 2px var(--space-2); border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); line-height: 18px; white-space: nowrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip.busy { color: var(--accent); background: var(--accent-soft); }
.chip.good { color: var(--ok); }
.chip.warn { color: var(--warn); }
.chip.bad { color: var(--danger); }
.where { margin: 0; overflow: hidden; color: var(--text-faint); font: var(--text-xs) var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.hint { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.fns { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.fns li { padding: 1px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface-2); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
.actions { display: flex; justify-content: flex-end; }
.link { color: var(--accent); font-size: var(--text-sm); font-weight: var(--weight-medium); text-decoration: none; }
.link:hover { text-decoration: underline; }
</style>
