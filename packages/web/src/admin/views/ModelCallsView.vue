<script setup lang="ts">
/**
 * Every model call the hub made, of every modality (chat, embeddings, images, transcription, speech), searched,
 * filtered and sorted by the hub (the query in the URL, plus the run a link narrowed it to) and kept live while open. A call opens beside
 * the list (`?call=`); a chat call shows what the model saw and said.
 */
import { ModelCallId, RunId } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { LlmCallTab, TAB_KEYS } from '../../chat/logic/inspect.ts';
import { useStores } from '../../state/stores.ts';
import ListSearch from '../../components/query/ListSearch.vue';
import { hubListQuery, useListQuery } from '../../state/query.ts';
import { UiButton, UiIcon, UiSkeleton } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import BrowserFrame from '../components/BrowserFrame.vue';
import BrowserRow from '../components/BrowserRow.vue';
import ModelCallDetails from '../components/ModelCallDetails.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { BROWSER_REFRESH } from '../logic/browsers.ts';
import { callPurpose, callTook, MODALITY_WORDS, MODEL_CALL_STATUS_LOOK, unitsText } from '../logic/model-calls.ts';

const { admin } = useStores();
const calls = admin.modelCalls;
const router = useRouter();
const now = useNow(1_000);
const query = useRouteQuery(ROUTES.modelCalls);
const search = useListQuery('modelCalls');
const run = query.text('run');
const opened = query.text('call', { push: true });
const callTab = query.choice(TAB_KEYS.llm, LlmCallTab, 'saw');

const filter = computed(() => {
  const forRun = RunId.safeParse(run.value);
  return { query: hubListQuery(search.value), ...(forRun.success ? { run: forRun.data } : {}) };
});
const narrowed = computed(() => filter.value.run !== undefined || Object.keys(filter.value.query).some((key) => key !== 'sort'));
const items = computed(() => calls.list.items.value);
const openedCall = computed(() => calls.opened.value.value);
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) { opened.value = ''; } } });

watch(filter, (value, before) => { if (JSON.stringify(value) !== JSON.stringify(before)) { void calls.list.load(value); } }, { immediate: true });
watch(opened, (id) => {
  const parsed = ModelCallId.safeParse(id);
  if (parsed.success) { void calls.open(parsed.data); } else { calls.close(); }
}, { immediate: true });
useLive(() => { void calls.list.refresh(); }, BROWSER_REFRESH);
</script>

<template>
  <AppPage title="Model calls" description="Every call to a model, of every kind: what it used, cost and took, and what it was for.">
    <BrowserFrame
      v-model:panel="panel" label="Model calls" :loading="calls.list.loading.value" :loaded="calls.list.loaded.value" :problem="calls.list.problem.value"
      :empty="items.length === 0" :has-more="calls.list.hasMore.value" :loading-more="calls.list.loadingMore.value"
      empty-icon="cpu" empty-title="No model calls match" :empty-body="narrowed ? 'Try a wider filter.' : 'Calls show here as agents and systems use models.'"
      :panel-title="openedCall ? openedCall.call.model : 'Model call'" :panel-subtitle="openedCall ? `${MODALITY_WORDS[openedCall.call.modality].label} · ${openedCall.call.provider}` : ''"
      @more="calls.list.more()" @retry="calls.list.load()"
    >
      <template #filters>
        <ListSearch v-model="search" list="modelCalls" label="model calls" :count="items.length" :more="calls.list.hasMore.value">
          <!-- the run the list was opened for (from the run inspector): shown, so it can be cleared -->
          <UiButton v-if="filter.run" size="sm" variant="secondary" icon="x" class="scope" data-testid="filter-run" @click="run = ''">Run {{ run }}</UiButton>
        </ListSearch>
      </template>
      <BrowserRow
        v-for="item in items" :key="item.id" :title="item.model" :detail="`${item.provider} · ${callPurpose(item)}`" :at="item.startedAt" :now="now"
        :selected="opened === item.id" :testid="`model-call-${item.id}`" @open="opened = item.id"
      >
        <template #mark><UiIcon :name="MODALITY_WORDS[item.modality].icon" :size="16" :label="MODALITY_WORDS[item.modality].label" /></template>
        <template #badges><StatusBadge :look="MODEL_CALL_STATUS_LOOK[item.status]" /></template>
        <template #figures>
          <span v-if="item.status === 'done'">{{ unitsText(item.units) }}</span>
          <span>{{ formatCost(item.cost) }}</span>
          <span v-if="callTook(item, now) !== undefined">{{ formatDuration(callTook(item, now) ?? 0) }}</span>
        </template>
      </BrowserRow>
      <template #panel>
        <div class="panel">
          <p v-if="calls.opened.problem.value !== ''" class="problem" role="alert">{{ calls.opened.problem.value }}</p>
          <UiSkeleton v-if="openedCall === undefined && calls.opened.loading.value" shape="lines" :lines="8" />
          <ModelCallDetails
            v-if="openedCall" v-model:tab="callTab" :call="openedCall.call" :interaction="openedCall.interaction"
            @run="router.push(links.runs({ run: $event }))" @session="router.push(links.session($event))"
          />
        </div>
      </template>
    </BrowserFrame>
  </AppPage>
</template>

<style scoped>
.panel { display: grid; gap: var(--space-3); min-width: 0; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.scope { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
</style>
