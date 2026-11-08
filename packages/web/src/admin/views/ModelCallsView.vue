<script setup lang="ts">
/**
 * Every model call the hub made, of every modality (chat, embeddings, images, transcription, speech), newest first,
 * narrowed by modality, status, model, system and chat (all in the URL) and kept live while open. A call opens beside
 * the list (`?call=`); a chat call shows what the model saw and said.
 */
import { Modality, ModelCallFilter, ModelCallId, ModelCallStatus } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import { LlmCallTab, TAB_KEYS } from '../../chat/logic/inspect.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiIcon, UiInput, UiSelect, UiSkeleton, type SelectOption } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import BrowserFrame from '../components/BrowserFrame.vue';
import BrowserRow from '../components/BrowserRow.vue';
import ModelCallDetails from '../components/ModelCallDetails.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { BROWSER_REFRESH, filterOf } from '../logic/browsers.ts';
import { callPurpose, callTook, MODALITY_WORDS, MODEL_CALL_STATUS_LOOK, unitsText } from '../logic/model-calls.ts';

const { admin } = useStores();
const calls = admin.modelCalls;
const router = useRouter();
const now = useNow(1_000);
const query = useRouteQuery(ROUTES.modelCalls);
const modality = query.text('modality');
const status = query.text('status');
const model = query.draft('model');
const system = query.draft('system');
const session = query.text('session');
const run = query.text('run');
const opened = query.text('call', { push: true });
const callTab = query.choice(TAB_KEYS.llm, LlmCallTab, 'saw');

const modalities: readonly SelectOption<Modality | ''>[] = [{ value: '', label: 'Every kind' }, ...Modality.options.map((m) => ({ value: m, label: MODALITY_WORDS[m].label }))];
const statuses: readonly SelectOption<ModelCallStatus | ''>[] = [{ value: '', label: 'Any status' }, ...ModelCallStatus.options.map((s) => ({ value: s, label: MODEL_CALL_STATUS_LOOK[s].word }))];
const modalityChoice = computed<Modality | ''>({ get: () => modalities.find((m) => m.value === modality.value)?.value ?? '', set: (value) => { modality.value = value; } });
const statusChoice = computed<ModelCallStatus | ''>({ get: () => statuses.find((s) => s.value === status.value)?.value ?? '', set: (value) => { status.value = value; } });
const filter = computed(() => filterOf(ModelCallFilter, {
  modality: modality.value, status: status.value, model: model.value.value, system: system.value.value, session: session.value, run: run.value,
}));
const narrowed = computed(() => Object.keys(filter.value).length > 0);
const items = computed(() => calls.list.items.value);
const openedCall = computed(() => calls.opened.value.value);
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) { opened.value = ''; } } });

watch(filter, (value) => { void calls.list.load(value); }, { immediate: true });
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
        <UiSelect v-model="modalityChoice" :options="modalities" label="Kind" data-testid="filter-modality" />
        <UiSelect v-model="statusChoice" :options="statuses" label="Status" />
        <UiInput v-model="model.draft.value" type="search" label="Model" placeholder="Any" clearable />
        <UiInput v-model="system.draft.value" type="search" label="System" placeholder="Any" clearable />
        <!-- a run or session the list was opened for (from the run inspector or a session): shown, so it can be cleared -->
        <UiButton v-if="run !== ''" size="sm" variant="secondary" icon="x" class="scope" data-testid="filter-run" @click="run = ''">Run {{ run }}</UiButton>
        <UiButton v-if="session !== ''" size="sm" variant="secondary" icon="x" class="scope" data-testid="filter-session" @click="session = ''">Session {{ session }}</UiButton>
      </template>
      <BrowserRow
        v-for="item in items" :key="item.id" :title="item.model" :detail="`${item.provider} · ${callPurpose(item)}`" :at="item.startedAt" :now="now"
        :selected="opened === item.id" :testid="`model-call-${item.id}`" @open="opened = item.id"
      >
        <template #mark><UiIcon :name="MODALITY_WORDS[item.modality].icon" :size="16" :label="MODALITY_WORDS[item.modality].label" /></template>
        <template #badges><StatusBadge :look="MODEL_CALL_STATUS_LOOK[item.status]" /></template>
        <template #figures>
          <span v-if="item.status !== 'running'">{{ unitsText(item.units) }}</span>
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
.scope { align-self: end; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
</style>
