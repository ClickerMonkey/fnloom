<script setup lang="ts">
/**
 * One run for its own person (`/run/:run`), and for admins: where a run outside any chat opens (a hub MCP call, a run a
 * system started for its owner, the run a notification names). It shows the run as the chat draws it (its fn as a
 * pill, status, cost and time, and its result through the fn's own renderer or its system's result renderer, else
 * rows or the result in brief), the approval card while it waits for its person, the pages it relates to (the
 * notification's second link, its chat, the run that called it), its details (args, result, changes, errors, JSON; the
 * tab in the URL) and what it called, as a tree whose runs open their own pages. Undo takes back a run outside a chat
 * (it and everything it called) for the person it ran for. The hub checks who may see it: anyone else reads it as
 * missing. Live while it is going.
 */
import { RunId, type Json, type LlmInteractionId } from '@harness/core';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { useLive } from '../app/live.ts';
import { links, notificationTarget, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import { BROWSER_REFRESH } from '../admin/logic/browsers.ts';
import ApprovalCard from '../components/approvals/ApprovalCard.vue';
import RunCard from '../chat/components/RunCard.vue';
import RunDetails from '../chat/components/RunDetails.vue';
import TurnTree from '../chat/components/TurnTree.vue';
import { fnLabel } from '../chat/logic/labels.ts';
import { RunTab, TAB_KEYS } from '../chat/logic/inspect.ts';
import { useFnModal } from '../fns/state/fn-modal.ts';
import { useFnNotice } from '../fns/state/fn-notices.ts';
import { alsoOf, canUndo, hasBranch, isLive, relatedLinks, undoSummary } from '../runs/logic.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiButton, UiCard, UiEmpty, UiIcon, fullTime } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { chat, session, toasts, runPage } = useStores();
const route = useRoute();
const router = useRouter();
const now = useNow(1_000);
const fnModal = useFnModal();
const noticeOf = useFnNotice();
const query = useRouteQuery(ROUTES.run);
const tab = query.choice(TAB_KEYS.run, RunTab, 'overview');
const alsoText = query.text('also');

const store = runPage();
const id = computed(() => {
  const parsed = RunId.safeParse(route.params['run']);
  return parsed.success ? parsed.data : undefined;
});
const record = computed(() => store.run.value.value);
const me = computed(() => session.user.value?.id);
const admin = computed(() => session.user.value?.role === 'admin');
const title = computed(() => (record.value === undefined ? 'Run' : fnLabel(record.value.fn)));
const description = computed(() => (record.value === undefined ? '' : `${record.value.fn}${record.value.startedAt === undefined ? '' : ` · started ${fullTime(record.value.startedAt)}`}`));
const undoable = computed(() => record.value !== undefined && canUndo(record.value, me.value));
/** The fn's own renderer, when its system has one (a run outside a chat has no session state to give it). */
const view = computed(() => (record.value === undefined ? undefined : chat.renderers.fnView(record.value, {})));
const argsType = computed(() => (record.value === undefined ? undefined : chat.capabilities.invocation(record.value.fn)?.args));
const collapsed = ref(false);

/** The notification's second link, where it leads (resolved once: a run in it may be in a chat). */
const also = computed(() => alsoOf(alsoText.value));
const alsoTo = shallowRef<RouteLocationRaw | undefined>(undefined);
watch(also, async (next) => {
  alsoTo.value = next === undefined ? undefined : await notificationTarget(next.link, (run) => chat.sessionOfRun(run));
}, { immediate: true });
const related = computed(() => (record.value === undefined ? [] : relatedLinks(record.value, {
  session: (s) => links.session(s), run: (r) => links.run(r), admin: (r) => links.runs({ run: r }),
}, { admin: admin.value, also: also.value === undefined || alsoTo.value === undefined ? undefined : { label: also.value.label, to: alsoTo.value } })));

watch(id, (next) => { if (next !== undefined) { void store.open(next); } }, { immediate: true });
onMounted(() => { void chat.prepareRenderers(); });
useLive(() => { if (isLive(record.value)) { void store.refresh(); } }, BROWSER_REFRESH);

async function decide(approve: boolean, reason: string, answer: Json | undefined): Promise<void> {
  if (await store.decide(approve, reason, answer)) { toasts.ok(approve ? 'Approved' : 'Denied'); } else { toasts.error("Couldn't send your answer", store.acting.problem.value); }
}

async function undo(): Promise<void> {
  const result = await store.undo();
  if (!result.ok) { toasts.error("Couldn't undo it", result.problem); return; }
  const { tone, body } = undoSummary(result.value);
  toasts.push({ tone, title: 'Undone', body });
}

async function background(): Promise<void> {
  const result = await store.background();
  if (result.ok) { toasts.ok(result.value ? 'Moved to the background' : "It couldn't move now"); } else { toasts.error(result.problem); }
}

/** Bring a part of the page into view (the details, the tree). */
function show(part: 'run-details' | 'run-tree'): void {
  document.getElementById(part)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openLlm(call: LlmInteractionId): void {
  if (admin.value) { void router.push(links.llmCalls({ call })); }
}
</script>

<template>
  <AppPage :title="title" :description="description" width="readable" keep-title>
    <template #crumb>
      <RouterLink :to="links.inbox()" class="crumb" data-testid="back-to-inbox"><UiIcon name="chevron-left" :size="14" />Inbox</RouterLink>
    </template>
    <template v-if="undoable" #actions>
      <UiButton icon="undo" :loading="store.acting.busy.value" data-testid="run-undo" @click="undo">Undo</UiButton>
    </template>
    <UiEmpty v-if="id === undefined" icon="fn" title="No such run" body="This link doesn't name a run." data-testid="run-missing" />
    <LoadState v-else :loading="store.run.loading.value" :problem="store.run.problem.value" :ready="record !== undefined" :empty="false" :lines="6" @retry="store.open(id)">
      <div v-if="record" class="run-page" data-testid="run-page" :data-run="record.id" :data-status="record.status">
        <UiBanner v-if="record.status === 'undone'" icon="undo" data-testid="run-undone">Undone: what it changed was taken back.</UiBanner>
        <ApprovalCard
          v-if="store.approval.value" :ident="store.approval.value.id" :fn="store.approval.value.fn" description="" :args="record.args" :preview="store.approval.value.preview"
          :ask="store.approval.value.ask" :rememberable="false" :notice="noticeOf(store.approval.value.fn)" data-testid="run-approval"
          @decide="(approve, _remember, reason, answer) => decide(approve, reason, answer)"
        />
        <UiBanner v-else-if="record.status === 'awaiting-approval'" tone="warn" icon="shield" data-testid="run-waits">
          It waits for an approval.
          <template #actions><UiButton size="sm" variant="ghost" @click="router.push(links.inbox())">Inbox</UiButton></template>
        </UiBanner>

        <RunCard :run="record" :now="now" :collapsed="collapsed" :view="view" :notice="noticeOf(record.fn)" @toggle="collapsed = $event" @open="tab = 'overview'; show('run-details')" @background="background" />

        <nav v-if="related.length > 0" class="related" aria-label="Related pages" data-testid="run-related">
          <UiButton v-for="link in related" :key="link.key" size="sm" variant="ghost" :icon="link.icon" :data-testid="`run-related-${link.key}`" @click="router.push(link.to)">{{ link.label }}</UiButton>
        </nav>

        <UiCard id="run-details" title="Details" class="part">
          <RunDetails
            v-model:tab="tab" :run="record" :record="record" :loading="false" :now="now" :args-type="argsType" :can-see-calls="admin" :undoable="false"
            @background="background" @tree="show('run-tree')" @llm="openLlm" @run="router.push(links.run($event))" @calls="router.push(links.modelCalls({ run: $event }))"
            @fn="fnModal?.open($event)" @retry="store.open(record.id)"
          />
        </UiCard>

        <UiCard v-if="hasBranch(store.branch.value) || store.tree.problem.value !== ''" id="run-tree" title="What it called" class="part">
          <TurnTree
            :tree="store.branch.value" :loading="store.tree.loading.value" :problem="store.tree.problem.value" :live="() => undefined"
            @run="router.push(links.run($event))" @llm="openLlm" @retry="store.refresh()"
          />
        </UiCard>
      </div>
    </LoadState>
  </AppPage>
</template>

<style scoped>
.run-page { display: grid; gap: var(--space-4); min-width: 0; }
.related { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.part { min-width: 0; scroll-margin-top: var(--space-6); }
.crumb { display: inline-flex; align-items: center; gap: 2px; color: var(--text-dim); font-size: var(--text-sm); text-decoration: none; }
.crumb:hover { color: var(--text); }
</style>
