<script setup lang="ts">
/**
 * The LLM calls browser: every call the hub made, newest first, narrowed by status, model, system and chat (all in
 * the URL), kept live while open. A call opens beside the list (`?call=`) showing what the model saw and said.
 */
import { LlmInteractionId, LlmStatus } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links } from '../../app/routes.ts';
import { useQueryChoice, useQueryDraft, useQueryText } from '../../app/url.ts';
import { LlmCallTab, TAB_KEYS } from '../../chat/logic/inspect.ts';
import LlmCallDetails from '../../chat/components/LlmCallDetails.vue';
import { formatCost, formatDuration, formatTokens } from '../../chat/logic/format.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiInput, UiSelect, UiSkeleton, type SelectOption } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import BrowserFrame from '../components/BrowserFrame.vue';
import BrowserRow from '../components/BrowserRow.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { LlmFilter } from '@harness/core';
import { BROWSER_REFRESH, LLM_STATUS_LOOK, filterOf, llmTimes } from '../logic/browsers.ts';

const { admin } = useStores();
const llm = admin.llm;
const router = useRouter();
const now = useNow(1_000);
const status = useQueryText('status');
const model = useQueryDraft('model');
const system = useQueryDraft('system');
const session = useQueryText('session');
const opened = useQueryText('call', { push: true });
const callTab = useQueryChoice(TAB_KEYS.llm, LlmCallTab, 'saw');

const statuses: readonly SelectOption<LlmStatus | ''>[] = [{ value: '', label: 'Any status' }, ...LlmStatus.options.map((s) => ({ value: s, label: LLM_STATUS_LOOK[s].word }))];
const statusChoice = computed<LlmStatus | ''>({
  get: () => statuses.find((s) => s.value === status.value)?.value ?? '',
  set: (value) => { status.value = value; },
});
const filter = computed(() => filterOf(LlmFilter, { status: status.value, model: model.value.value, system: system.value.value, session: session.value }));
const items = computed(() => llm.list.items.value);
const call = computed(() => llm.opened.value.value);
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) { opened.value = ''; } } });

watch(filter, (value) => { void llm.list.load(value); }, { immediate: true });
watch(opened, (id) => {
  const parsed = LlmInteractionId.safeParse(id);
  if (parsed.success) { void llm.open(parsed.data); } else { llm.close(); }
}, { immediate: true });
useLive(() => { void llm.list.refresh(); }, BROWSER_REFRESH);
</script>

<template>
  <AppPage title="LLM calls" description="Every call to a model: what it saw, what it said, how long it took and what it cost.">
    <BrowserFrame
      v-model:panel="panel" label="LLM calls" :loading="llm.list.loading.value" :loaded="llm.list.loaded.value" :problem="llm.list.problem.value"
      :empty="items.length === 0" :has-more="llm.list.hasMore.value" :loading-more="llm.list.loadingMore.value"
      empty-icon="chat" empty-title="No LLM calls match" :empty-body="filter.status || filter.model || filter.system ? 'Try a wider filter.' : 'Calls show here as agents think.'"
      :panel-title="call ? call.model : 'LLM call'" :panel-subtitle="call ? `${call.provider} · step ${call.iteration + 1}` : ''" @more="llm.list.more()" @retry="llm.list.load()"
    >
      <template #filters>
        <UiSelect v-model="statusChoice" :options="statuses" label="Status" />
        <UiInput v-model="model.draft.value" type="search" label="Model" placeholder="Any" clearable />
        <UiInput v-model="system.draft.value" type="search" label="System" placeholder="Any" clearable />
      </template>
      <BrowserRow
        v-for="item in items" :key="item.id" :title="item.model" :detail="`${item.provider}${item.system ? ` · for ${item.system}` : ''} · step ${item.iteration + 1}`"
        :at="item.queuedAt" :now="now" :selected="opened === item.id" :testid="`llm-${item.id}`" @open="opened = item.id"
      >
        <template #badges><StatusBadge :look="LLM_STATUS_LOOK[item.status]" /></template>
        <template #figures>
          <span v-if="item.usage" :title="`${item.usage.input} in, ${item.usage.output} out`">{{ formatTokens(item.usage.input + item.usage.output) }} tok</span>
          <span>{{ formatCost(item.cost) }}</span>
          <span v-if="llmTimes(item, now).total !== undefined">{{ formatDuration(llmTimes(item, now).total ?? 0) }}</span>
        </template>
      </BrowserRow>
      <template #panel>
        <div class="panel">
          <p v-if="llm.opened.problem.value !== ''" class="problem" role="alert">{{ llm.opened.problem.value }}</p>
          <UiSkeleton v-if="call === undefined && llm.opened.loading.value" shape="lines" :lines="8" />
          <template v-if="call">
            <div class="links">
              <UiButton size="sm" variant="ghost" icon="fn" @click="router.push(links.runs({ run: call.run }))">The run that asked</UiButton>
              <UiButton v-if="call.session" size="sm" variant="ghost" icon="chat" @click="call.session && router.push(links.session(call.session))">Its chat</UiButton>
            </div>
            <LlmCallDetails v-model:tab="callTab" :call="call" />
          </template>
        </div>
      </template>
    </BrowserFrame>
  </AppPage>
</template>

<style scoped>
.panel { display: grid; gap: var(--space-3); min-width: 0; }
.links { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
