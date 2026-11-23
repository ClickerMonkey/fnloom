<script setup lang="ts">
/**
 * A run of a schedule fn (one firing, or a run started by hand), drawn as the `schedule/schedule` kind's result
 * renderer wherever the run is shown (its run page, the chat): a header with the schedule's name, when the run was
 * planned for in the viewer's zone, and a link to its history, above the target's own result drawn by the app's result
 * view (`RESULT_VIEW`).
 */
import { CHAT_HOST, RESULT_VIEW, type ResultView, type UntypedFn, type WithSystem } from '@harness/sdk';
import type { ScheduleContract } from '../shared/index.ts';
import { computed, inject } from 'vue';
import { viewerZone } from './logic.ts';
import { firingHeader } from './results.ts';

const props = defineProps<ResultView<UntypedFn> & WithSystem<ScheduleContract['defs']>>();
const ResultViewComponent = inject(RESULT_VIEW, undefined);
const chat = inject(CHAT_HOST, undefined);
const header = computed(() => firingHeader(props.fn, props.args, viewerZone(undefined)));

function open(event: MouseEvent, href: string): void {
  if (chat === undefined || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) { return; }
  event.preventDefault();
  chat.navigate(href);
}
</script>

<template>
  <section class="firing" data-testid="schedule-firing">
    <header class="head">
      <a class="title" :href="header.href" @click="open($event, header.href)">{{ header.title }}</a>
      <span class="when" data-testid="schedule-firing-when">{{ header.when }}</span>
      <a class="history" :href="header.historyHref" @click="open($event, header.historyHref)">History</a>
    </header>
    <component :is="ResultViewComponent" v-if="ResultViewComponent" :value="result" :fn="fn" :args="args" :title="title" :view-key="run" />
  </section>
</template>

<style scoped>
.firing { display: grid; gap: var(--space-2); min-width: 0; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); font-size: var(--text-sm); }
.title { color: var(--text); font-weight: var(--weight-strong); text-decoration: none; }
.title:hover { color: var(--accent); text-decoration: underline; }
.when { color: var(--text-dim); }
.history { color: var(--accent); text-decoration: none; }
.history:hover { text-decoration: underline; }
</style>
