<script setup lang="ts">
/**
 * The bash card: the command and where it ran, a live status chip and progress while it runs (with the last line
 * it printed), its output folded until expanded, copy, and "Run again" through the system's `rerun` action.
 */
import { isSettled, type FnViewOf } from '@harness/sdk';
import { computed, onBeforeUnmount, ref } from 'vue';
import type { fs } from '../shared/index.ts';
import { deliveryChip, failedOutput, percent, statusChip } from './bash.ts';
import OutputBlock from './OutputBlock.vue';
import { useRerun } from './rerun.ts';

const view = defineProps<FnViewOf<typeof fs, 'bash'>>();

/** How long "Copied" shows after copying. */
const COPIED_FOR = 1_600;

const chip = computed(() => statusChip(view.status, view.result?.exitCode, view.error));
const running = computed(() => view.status === 'running');
/** Copy and Run again only make sense once the command has run. */
const settled = computed(() => isSettled(view.status));
const output = computed(() => view.result ?? failedOutput(view.error));
const where = computed(() => view.args.cwd ?? view.state.cwd);
const fraction = computed(() => percent(view.progress?.fraction));
const live = computed(() => view.progress?.message ?? '');

const rerun = useRerun(() => view.system.send.rerun({ command: view.args.command }));
const rerunChip = computed(() => (rerun.delivery.value === undefined ? undefined : deliveryChip(rerun.delivery.value.status, rerun.result.value?.exitCode)));

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(): Promise<void> {
  const shown = rerun.result.value ?? output.value;
  const text = [`$ ${view.args.command}`, shown?.stdout ?? '', shown?.stderr ?? ''].filter((part) => part.trim() !== '').join('\n');
  await navigator.clipboard.writeText(text);
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = false; }, COPIED_FOR);
}
onBeforeUnmount(() => { clearTimeout(copiedTimer); });
</script>

<template>
  <article class="bash" :data-tone="chip.tone" :aria-busy="running">
    <header class="head">
      <span class="prompt" aria-hidden="true">$</span>
      <code class="command" :title="view.args.command">{{ view.args.command }}</code>
      <span class="chip" :class="chip.tone" role="status"><span class="dot" aria-hidden="true" />{{ chip.label }}</span>
    </header>
    <p v-if="where" class="where" :title="where">in {{ where }}</p>

    <div v-if="running" class="progress" role="progressbar" :aria-valuenow="fraction" aria-valuemin="0" aria-valuemax="100">
      <div class="bar" :style="{ width: `${Math.max(fraction, 4)}%` }" />
    </div>
    <p v-if="running && live" class="live" aria-live="polite">{{ live }}</p>

    <OutputBlock v-if="output" :stdout="output.stdout" :stderr="output.stderr" />
    <p v-if="view.error && view.error.code !== 'timeout'" class="problem">{{ view.error.message }}</p>

    <footer v-if="settled" class="actions">
      <button type="button" class="action" :disabled="!output" @click="copy">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5" /><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" /></svg>
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
      <button type="button" class="action primary" :disabled="rerun.busy.value" @click="rerun.run()">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>
        Run again
      </button>
      <span v-if="!view.system.online" class="offline">fs is offline; it will run when it reconnects</span>
    </footer>

    <section v-if="rerunChip" class="again" aria-label="Run again">
      <header class="again-head">
        <span>Again</span>
        <span class="chip" :class="rerunChip.tone"><span class="dot" aria-hidden="true" />{{ rerunChip.label }}</span>
      </header>
      <OutputBlock v-if="rerun.result.value" :stdout="rerun.result.value.stdout" :stderr="rerun.result.value.stderr" />
      <p v-if="rerun.error.value" class="problem">{{ rerun.error.value }}</p>
    </section>
  </article>
</template>

<style scoped>
.bash {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  transition: border-color var(--slow) var(--ease);
}
.bash[data-tone='busy'] { border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
.bash[data-tone='bad'] { border-color: color-mix(in oklab, var(--danger) 35%, var(--border)); }
.head { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.prompt { color: var(--accent); font: var(--weight-strong) var(--text-sm)/1.4 var(--mono); flex: none; }
.command {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-sm)/1.4 var(--mono);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  line-height: 18px;
  white-space: nowrap;
  background: var(--surface-2);
  color: var(--text-dim);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip.busy { color: var(--accent); background: var(--accent-soft); }
.chip.busy .dot { animation: pulse 1.2s var(--ease) infinite; }
.chip.ok { color: var(--ok); background: var(--ok-soft); }
.chip.bad { color: var(--danger); background: var(--danger-soft); }
.where { margin: 0; color: var(--text-dim); font: var(--text-xs)/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.progress { height: 3px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), color-mix(in oklab, var(--accent) 55%, white), var(--accent));
  background-size: 200% 100%;
  animation: flow 1.4s linear infinite;
  transition: width var(--slow) var(--ease);
}
.live { margin: 0; color: var(--text-dim); font: var(--text-xs)/1.4 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease), transform var(--fast) var(--ease);
}
.action:hover:not(:disabled) { background: var(--surface-2); }
.action:active:not(:disabled) { transform: scale(0.97); }
.action:disabled { opacity: 0.5; cursor: default; }
.action.primary { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 35%, var(--border)); }
.action svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.offline { color: var(--text-dim); font-size: var(--text-xs); }
.again { display: grid; gap: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--border); animation: rise var(--slow) var(--ease); }
.again-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-xs); }
@keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
@keyframes flow { to { background-position: -200% 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) {
  .bar, .chip.busy .dot { animation: none; }
}
</style>
