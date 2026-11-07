<script setup lang="ts">
/**
 * The chat page, wired to the URL: the list of chats (a column on wide screens, a drawer on narrow ones, the page
 * itself at `/chat` on a phone), the open chat, and the panel over it (a run, a turn's tree, an LLM call, an
 * answer's details, a resource, the chat's settings), as a side column on wide screens and a sheet otherwise. It
 * loads what each panel needs when the URL asks for it, and owns the chat's keyboard shortcuts.
 */
import type { LlmInteraction, MessageId, SessionId } from '@harness/core';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiEmpty, UiModal, useMediaQuery } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import LlmCallDetails from '../components/LlmCallDetails.vue';
import PanelFrame from '../components/PanelFrame.vue';
import PanelHost from '../components/PanelHost.vue';
import ResourceView from '../components/ResourceView.vue';
import RunDetails from '../components/RunDetails.vue';
import SessionList from '../components/SessionList.vue';
import SessionSettings from '../components/SessionSettings.vue';
import ShortcutsDialog from '../components/ShortcutsDialog.vue';
import TurnDetails from '../components/TurnDetails.vue';
import TurnTree from '../components/TurnTree.vue';
import type { SessionListHandle } from '../components/types.ts';
import { resourceRenderView } from '../state/renderers.ts';
import { isTyping, shortcutFor } from '../logic/keys.ts';
import { agentName, fnLabel } from '../logic/labels.ts';
import { mergeRecord } from '../logic/runs.ts';
import { useChatUrl } from '../url.ts';
import ThreadPane from './ThreadPane.vue';

const { chat, toasts, session: auth } = useStores();
const url = useChatUrl();
const now = useNow();
const wide = useMediaQuery('(min-width: 1100px)');
const roomy = useMediaQuery('(min-width: 1360px)');
const phone = useMediaQuery('(max-width: 759.98px)');
const compact = computed(() => !wide.value);

const listOpen = ref(false);
const shortcutsOpen = ref(false);
const list = ref<SessionListHandle | null>(null);
const pane = ref<{ focusComposer: () => void } | null>(null);
const sessions = chat.sessions;

const thread = computed(() => (url.session.value === undefined ? undefined : chat.thread(url.session.value)));
const record = computed(() => thread.value?.session.value);

// ── the list ─────────────────────────────────────────────────────────────────

async function create(): Promise<void> {
  const made = await sessions.create();
  if (made === undefined) { toasts.error("Couldn't start a chat", sessions.problem.value); return; }
  listOpen.value = false;
  url.go(made.id);
}

function open(id: SessionId): void {
  listOpen.value = false;
  url.go(id);
}

async function rename(id: SessionId, title: string): Promise<void> {
  if (!(await sessions.rename(id, title))) { toasts.error("Couldn't rename", sessions.problem.value); }
}

async function archive(id: SessionId, archived: boolean): Promise<void> {
  if (!(await sessions.archive(id, archived))) { toasts.error("Couldn't change that chat", sessions.problem.value); return; }
  toasts.ok(archived ? 'Archived' : 'Restored');
}

function step(by: number): void {
  const items = sessions.items.value;
  const at = items.findIndex((s) => s.id === url.session.value);
  const next = items[Math.max(0, Math.min(items.length - 1, at + by))];
  if (next !== undefined && next.id !== url.session.value) { url.go(next.id); }
}

// ── panels ───────────────────────────────────────────────────────────────────

const panelOpen = computed({ get: () => url.top.value !== undefined, set: (open) => { if (!open) { url.close(); } } });
const runView = computed(() => {
  const id = url.run.value;
  if (id === undefined) { return undefined; }
  const live = thread.value?.runs.value.get(id);
  const fetched = chat.inspector.run.value.value;
  return fetched?.id === id ? mergeRecord(live, fetched) : live;
});
const llmCall = computed(() => (url.llm.value === undefined ? undefined : chat.inspector.calls.value.get(url.llm.value)));
const turnCalls = shallowRef<readonly LlmInteraction[]>([]);
const turnLoading = ref(false);
const resourceView = computed(() => resourceRenderView(chat.renderers, chat.inspector.resource.value.value));

const panelTitle = computed(() => {
  switch (url.top.value) {
    case 'run': return runView.value === undefined ? 'Run' : fnLabel(runView.value.fn);
    case 'llm': return 'LLM call';
    case 'details': return 'Answer details';
    case 'tree': return 'Run tree';
    case 'resource': return chat.inspector.resource.value.value?.stat.name ?? 'Resource';
    case 'panel': return url.panel.value === 'people' ? 'People' : 'Chat settings';
    case undefined: return '';
  }
});
const panelSubtitle = computed(() => {
  switch (url.top.value) {
    case 'run': return runView.value?.fn ?? '';
    case 'llm': return llmCall.value?.model ?? '';
    case 'resource': return url.resource.value ?? '';
    default: return '';
  }
});

watch(url.run, (id) => { if (id !== undefined) { void chat.inspector.openRun(id); } }, { immediate: true });
watch(url.llm, (id) => { if (id !== undefined) { void chat.inspector.loadCalls([id]); } }, { immediate: true });
watch(url.resource, (uri) => { if (uri !== undefined) { void chat.inspector.openResource(uri); } }, { immediate: true });
watch(url.treeTurn, (turn) => { if (turn === undefined) { chat.inspector.closeTree(); } else { void chat.inspector.openTree(turn); } }, { immediate: true });
watch(url.details, async (turn) => {
  if (turn === undefined) { return; }
  turnLoading.value = true;
  turnCalls.value = await chat.inspector.loadTurn(turn);
  turnLoading.value = false;
}, { immediate: true });
// the open tree follows its turn's runs live
watch(() => thread.value?.runs.value, () => { if (url.treeTurn.value !== undefined) { chat.inspector.refreshTree(); } });

const liveStatus = (run: Parameters<typeof chat.inspector.openRun>[0]) => thread.value?.runs.value.get(run)?.status;
const nameOf = (p: { actor: string; role: string }): string => (p.actor === auth.user.value?.id ? (auth.user.value.name) : p.role === 'agent' ? (record.value === undefined ? 'Agent' : agentName(record.value.agent)) : 'Someone');

async function backgroundRun(): Promise<void> {
  const id = url.run.value;
  if (id !== undefined && thread.value !== undefined && !(await thread.value.toBackground(id))) { toasts.error("Couldn't move that to the background"); }
}

async function undoRunTurn(): Promise<void> {
  const turn = runView.value?.turn;
  if (turn === undefined || thread.value === undefined) { return; }
  const report = await thread.value.undoTurn(turn);
  if (report === undefined) { toasts.error("Couldn't undo", thread.value.problem.value); return; }
  toasts.ok(`Undid ${report.undone.length} change${report.undone.length === 1 ? '' : 's'}`);
}

// ── keys ─────────────────────────────────────────────────────────────────────

function onKey(event: KeyboardEvent): void {
  const action = shortcutFor(event, isTyping(document.activeElement));
  if (action === undefined) { return; }
  event.preventDefault();
  switch (action) {
    case 'search': if (compact.value) { listOpen.value = true; } setTimeout(() => { list.value?.focusSearch(); }, 0); return;
    case 'new-chat': void create(); return;
    case 'previous-chat': step(-1); return;
    case 'next-chat': step(1); return;
    case 'focus-composer': pane.value?.focusComposer(); return;
    case 'help': shortcutsOpen.value = true; return;
  }
}

function showMessage(id: MessageId): void {
  url.showMessage(id);
}

watch(url.session, (id) => { if (id === undefined) { chat.leave(); } });

onMounted(() => {
  chat.start();
  if (!sessions.loaded.value) { void sessions.load(); }
  if (url.session.value === undefined) { void chat.capabilities.load(undefined); }
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  chat.leave();
});
</script>

<template>
  <div class="chat" :class="{ compact, roomy: roomy && panelOpen }" data-testid="chat">
    <aside v-if="wide" class="list">
      <SessionList
        ref="list" :items="sessions.items.value" :current="url.session.value" :search="sessions.search.value" :archived="sessions.archived.value"
        :loading="sessions.loading.value" :loaded="sessions.loaded.value" :problem="sessions.problem.value" :has-more="sessions.hasMore.value"
        :loading-more="sessions.loadingMore.value" :creating="sessions.creating.value" :now="now"
        @open="open" @create="create" @search="sessions.setSearch($event)" @archived="sessions.showArchived($event)" @rename="rename" @archive="archive"
        @more="sessions.loadMore()" @retry="sessions.load()"
      />
    </aside>
    <UiModal v-else-if="url.session.value !== undefined" v-model:open="listOpen" placement="left" label="Chats" width="320px">
      <SessionList
        ref="list" :items="sessions.items.value" :current="url.session.value" :search="sessions.search.value" :archived="sessions.archived.value"
        :loading="sessions.loading.value" :loaded="sessions.loaded.value" :problem="sessions.problem.value" :has-more="sessions.hasMore.value"
        :loading-more="sessions.loadingMore.value" :creating="sessions.creating.value" :now="now"
        @open="open" @create="create" @search="sessions.setSearch($event)" @archived="sessions.showArchived($event)" @rename="rename" @archive="archive"
        @more="sessions.loadMore()" @retry="sessions.load()"
      />
    </UiModal>

    <main class="main">
      <ThreadPane
        v-if="url.session.value" ref="pane" :key="url.session.value" :session="url.session.value" :compact="compact" :narrow="roomy && panelOpen" :flash="url.message.value"
        @run="url.open('run', $event)" @llm="url.open('llm', $event)" @details="url.open('details', $event)" @tree="url.openTree($event)"
        @resource="url.open('resource', $event)" @panel="url.open('panel', $event)" @sessions="listOpen = true" @new-chat="create"
        @message="showMessage" @shortcuts="shortcutsOpen = true"
      />
      <SessionList
        v-else-if="compact" ref="list" class="home-list" :items="sessions.items.value" :search="sessions.search.value" :archived="sessions.archived.value"
        :loading="sessions.loading.value" :loaded="sessions.loaded.value" :problem="sessions.problem.value" :has-more="sessions.hasMore.value"
        :loading-more="sessions.loadingMore.value" :creating="sessions.creating.value" :now="now"
        @open="open" @create="create" @search="sessions.setSearch($event)" @archived="sessions.showArchived($event)" @rename="rename" @archive="archive"
        @more="sessions.loadMore()" @retry="sessions.load()"
      />
      <UiEmpty v-else class="home" icon="chat" tone="accent" title="Start a conversation" body="Chat with your agent, and run the fns your connected systems offer." data-testid="chat-home">
        <template #actions><UiButton variant="primary" icon="plus" :loading="sessions.creating.value" @click="create">New chat</UiButton></template>
      </UiEmpty>
    </main>

    <PanelHost v-if="url.session.value !== undefined" v-model:open="panelOpen" :inline="roomy" :phone="phone" :label="panelTitle" :data-panel="url.top.value">
      <PanelFrame :title="panelTitle" :subtitle="panelSubtitle" @close="url.close()">
        <RunDetails
          v-if="url.top.value === 'run'" :run="runView" :record="chat.inspector.run.value.value" :loading="chat.inspector.run.loading.value"
          :problem="chat.inspector.run.problem.value" :now="now" @background="backgroundRun" @tree="runView?.turn && url.openTree(runView.turn)" @undo="undoRunTurn"
          @llm="url.open('llm', $event)" @run="url.open('run', $event)" @retry="url.run.value && chat.inspector.openRun(url.run.value)"
        />
        <TurnTree
          v-else-if="url.top.value === 'tree'" :tree="chat.inspector.tree.value.value" :loading="chat.inspector.tree.loading.value" :problem="chat.inspector.tree.problem.value"
          :live="liveStatus" @run="url.open('run', $event)" @llm="url.open('llm', $event)" @retry="url.treeTurn.value && chat.inspector.openTree(url.treeTurn.value)"
        />
        <template v-else-if="url.top.value === 'llm'">
          <LlmCallDetails v-if="llmCall" :call="llmCall" />
          <p v-else class="dim">{{ (url.llm.value && chat.inspector.callProblems.value.get(url.llm.value)) || 'Loading…' }}</p>
        </template>
        <TurnDetails v-else-if="url.top.value === 'details'" :calls="turnCalls" :loading="turnLoading" :problem="chat.inspector.tree.problem.value" @llm="url.open('llm', $event)" />
        <ResourceView
          v-else-if="url.top.value === 'resource'" :read="chat.inspector.resource.value.value" :loading="chat.inspector.resource.loading.value"
          :problem="chat.inspector.resource.problem.value" :custom="resourceView" @retry="url.resource.value && chat.inspector.openResource(url.resource.value)"
        />
        <SessionSettings
          v-else-if="url.top.value === 'panel' && record && thread" :session="record" :systems="chat.capabilities.value.value?.systems ?? []" :notify="thread.notify.value"
          :agent="agentName(record.agent)" :name-of="nameOf" @notify="thread.update({ notify: $event })" @systems="thread.update({ systems: $event })"
        />
      </PanelFrame>
    </PanelHost>

    <ShortcutsDialog v-model:open="shortcutsOpen" />
  </div>
</template>

<style scoped>
.chat { display: grid; grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; min-height: 0; overflow: hidden; }
.chat.compact { grid-template-columns: minmax(0, 1fr); }
.chat.roomy { grid-template-columns: 300px minmax(0, 1fr) 440px; }
.chat.compact.roomy { grid-template-columns: minmax(0, 1fr) 440px; }
.list { min-height: 0; border-right: 1px solid var(--border); background: var(--surface); }
.main { position: relative; min-width: 0; min-height: 0; }
.home { height: 100%; align-content: center; }
.home-list { height: 100%; }
.dim { margin: 0; color: var(--text-faint); }
</style>
