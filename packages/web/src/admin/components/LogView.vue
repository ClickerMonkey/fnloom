<script setup lang="ts">
/**
 * An installed system's output, live: each line with its time and stream (errors stand out, the hub's own notes are
 * set apart). It follows new lines while scrolled to the end and stops following when the person scrolls up; a
 * button brings it back. Long lines wrap.
 */
import { nextTick, ref, watch } from 'vue';
import { UiButton, UiEmpty } from '../../ui/index.ts';
import type { OutputLine } from '@harness/core';

const props = withDefaults(defineProps<{ lines: readonly OutputLine[]; live?: boolean }>(), { live: true });
const box = ref<HTMLElement | null>(null);
const following = ref(true);

const time = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function onScroll(): void {
  const el = box.value;
  if (el === null) { return; }
  following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function toEnd(): void {
  following.value = true;
  void nextTick(() => { if (box.value !== null) { box.value.scrollTop = box.value.scrollHeight; } });
}

watch(() => props.lines.length, () => { if (following.value) { toEnd(); } }, { immediate: true, flush: 'post' });
</script>

<template>
  <div class="log-view">
    <UiEmpty v-if="lines.length === 0" icon="file" title="No output yet" body="Lines show here as the system writes them." />
    <div v-else ref="box" class="box" role="log" aria-live="polite" aria-label="Output" tabindex="0" data-testid="log" @scroll.passive="onScroll">
      <p v-for="(line, i) in lines" :key="i" class="line" :class="line.stream">
        <time class="at" :datetime="new Date(line.at).toISOString()">{{ time(line.at) }}</time>
        <span class="text">{{ line.text }}</span>
      </p>
    </div>
    <div class="foot">
      <span class="state" :class="{ live: live && following }">{{ live ? (following ? 'Following live' : 'Paused while you read') : 'Not live' }}</span>
      <UiButton v-if="!following" size="sm" icon="arrow-right" data-testid="log-follow" @click="toEnd">Jump to latest</UiButton>
    </div>
  </div>
</template>

<style scoped>
.log-view { display: grid; gap: var(--space-2); min-width: 0; }
.box {
  height: min(60vh, 560px); overflow: auto; padding: var(--space-3) 0; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--code-bg); font-family: var(--mono); font-size: var(--text-xs); line-height: 1.6;
}
.box:focus-visible { outline: none; box-shadow: var(--ring); }
.line { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); margin: 0; padding: 0 var(--space-4); }
.line:hover { background: var(--surface-2); }
.at { color: var(--text-faint); user-select: none; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.stderr .text { color: var(--danger); }
.hub { background: var(--accent-soft); }
.hub .text { color: var(--text-dim); font-style: italic; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: var(--control-sm); }
.state { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text-faint); font-size: var(--text-xs); }
.state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.state.live::before { background: var(--ok); animation: ui-pulse 1.6s var(--ease-in-out) infinite; }
</style>
