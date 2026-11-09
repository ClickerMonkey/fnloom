<script setup lang="ts">
/**
 * The runs browser: every run, searched, filtered and sorted by the hub (the query in the URL), kept live while it is
 * open. A run opens beside the list with its full record (`?run=`), linking on to its LLM call and its tree.
 */
import { RunId } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { ROUTES, links } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { RunTab, TAB_KEYS } from '../../chat/logic/inspect.ts';
import RunDetails from '../../chat/components/RunDetails.vue';
import RunDot from '../../chat/components/RunDot.vue';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { STATUS_LOOK, argSummary, runElapsed } from '../../chat/logic/runs.ts';
import { useStores } from '../../state/stores.ts';
import ListSearch from '../../components/query/ListSearch.vue';
import { hubListQuery, useListQuery } from '../../state/query.ts';
import { UiBadge } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import BrowserFrame from '../components/BrowserFrame.vue';
import BrowserRow from '../components/BrowserRow.vue';
import { BROWSER_REFRESH } from '../logic/browsers.ts';

const { admin, toasts } = useStores();
const runs = admin.runs;
const router = useRouter();
const now = useNow(1_000);
const query = useRouteQuery(ROUTES.runs);
const search = useListQuery('runs');
const opened = query.text('run', { push: true });
const runTab = query.choice(TAB_KEYS.run, RunTab, 'overview');

const filter = computed(() => hubListQuery(search.value));
const narrowed = computed(() => Object.keys(filter.value).some((key) => key !== 'sort'));
const items = computed(() => runs.list.items.value);
const record = computed(() => runs.opened.value.value);
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) { opened.value = ''; } } });

watch(filter, (value, before) => { if (JSON.stringify(value) !== JSON.stringify(before)) { void runs.list.load(value); } }, { immediate: true });
watch(opened, (id) => {
  const run = RunId.safeParse(id);
  if (run.success) { void runs.open(run.data); } else { runs.close(); }
}, { immediate: true });
useLive(() => { void runs.list.refresh(); if (record.value !== undefined && runs.openedId.value !== undefined && record.value.endedAt === undefined) { void runs.open(runs.openedId.value); } }, BROWSER_REFRESH);

async function background(): Promise<void> {
  const run = record.value;
  if (run === undefined) { return; }
  const result = await runs.background(run.id);
  if (result.ok) { toasts.ok(result.value.accepted ? 'Moved to the background' : "It couldn't move now"); } else { toasts.error(result.problem); }
}

async function undo(): Promise<void> {
  const run = record.value;
  if (run === undefined) { return; }
  const result = await runs.undoTurn(run.turn);
  if (!result.ok) { toasts.error(result.problem); return; }
  const { undone, failed, notUndoable } = result.value;
  toasts.push({ tone: failed.length > 0 ? 'warn' : 'ok', title: 'Turn undone', body: `${undone.length} undone, ${failed.length} failed, ${notUndoable.length} can't be undone.` });
}

function openTree(): void {
  const run = record.value;
  if (run?.session !== undefined) { void router.push(links.turnTree(run.session, run.turn)); }
}
</script>

<template>
  <AppPage title="Runs" description="Every fn call: what it was given, how it went, and what it cost.">
    <BrowserFrame
      v-model:panel="panel" label="Runs" :loading="runs.list.loading.value" :loaded="runs.list.loaded.value" :problem="runs.list.problem.value"
      :empty="items.length === 0" :has-more="runs.list.hasMore.value" :loading-more="runs.list.loadingMore.value"
      empty-icon="fn" empty-title="No runs match" :empty-body="narrowed ? 'Try a wider filter.' : 'Runs show here as fns are called.'"
      :panel-title="record ? fnLabel(record.fn) : 'Run'" :panel-subtitle="record?.fn ?? ''" @more="runs.list.more()" @retry="runs.list.load()"
    >
      <template #filters>
        <ListSearch v-model="search" list="runs" label="runs" :count="items.length" :more="runs.list.hasMore.value" :partial="runs.list.partial.value" />
      </template>
      <BrowserRow
        v-for="run in items" :key="run.id" :title="fnLabel(run.fn)" :detail="argSummary(run.args) || run.fn" :at="run.createdAt" :now="now"
        :selected="opened === run.id" :testid="`run-${run.id}`" @open="opened = run.id"
      >
        <template #mark><RunDot :status="run.status" :size="10" /></template>
        <template #badges>
          <UiBadge v-if="run.status === 'failed' || run.status === 'awaiting-approval'" :tone="STATUS_LOOK[run.status].tone">{{ STATUS_LOOK[run.status].word }}</UiBadge>
          <UiBadge v-if="run.attempt > 1" tone="warn">Try {{ run.attempt }}</UiBadge>
          <UiBadge v-if="run.background">Background</UiBadge>
        </template>
        <template #figures>
          <span>{{ formatCost(run.totalCost) }}</span>
          <span v-if="runElapsed(run, now) !== undefined">{{ formatDuration(runElapsed(run, now) ?? 0) }}</span>
        </template>
      </BrowserRow>
      <template #panel>
        <RunDetails
          v-model:tab="runTab" :run="record" :record="record" :loading="runs.opened.loading.value" :problem="runs.opened.problem.value" :now="now"
          @llm="router.push(links.llmCalls({ call: $event }))" @run="opened = $event" @tree="openTree" @background="background" @undo="undo" @retry="runs.openedId.value && runs.open(runs.openedId.value)"
        />
      </template>
    </BrowserFrame>
  </AppPage>
</template>
