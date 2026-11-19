<script setup lang="ts">
/**
 * The chat page, wired to the URL: the list of chats (a column on wide screens, a drawer on narrow ones, the page
 * itself at `/chat` on a phone), the open chat, and the panel over it (a run, a turn's tree, an LLM call, an
 * answer's details, a resource, the chat's settings), as a side column on wide screens and a sheet otherwise. It
 * loads what each panel needs when the URL asks for it, and owns the chat's keyboard shortcuts. The list's search
 * (`?q=`) and its active or archived view (`?chats=archived`) are in the URL too, and kept moving between chats. A
 * side panel takes the list's column unless the screen is very wide, so the thread keeps a readable width. Each kind
 * of panel keeps the width its left edge was dragged to (`LayoutStore.panelWidth`), within a share of the window.
 */
import { isSettled, ResourceUri, type LlmInteraction, type MessageId, type QualifiedName, type SessionId } from '@harness/core';
import { useRouter } from 'vue-router';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiEmpty, UiModal, useMediaQuery } from '../../ui/index.ts';
import { useTicker } from '../clock.ts';
import { COMPACT_QUERY, PANEL_WIDTH, panelWidthIn, panelWidthMax } from '../../state/layout.ts';
import ConfirmDialog from '../../admin/components/ConfirmDialog.vue';
import LlmCallDetails from '../components/LlmCallDetails.vue';
import PanelFrame from '../components/PanelFrame.vue';
import PanelHost from '../components/PanelHost.vue';
import ResourceViewer from '../../resources/ResourceViewer.vue';
import RunDetails from '../components/RunDetails.vue';
import SessionList from '../components/SessionList.vue';
import SessionSettings from '../components/SessionSettings.vue';
import ShortcutsDialog from '../components/ShortcutsDialog.vue';
import TurnDetails from '../components/TurnDetails.vue';
import TurnTree from '../components/TurnTree.vue';
import type { SessionListHandle } from '../components/types.ts';
import { LlmCallTab, RunTab, TAB_KEYS } from '../logic/inspect.ts';
import { isTyping, shortcutFor } from '../logic/keys.ts';
import { useRouteQuery } from '../../app/url.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { toastContextMade } from '../../context/made.ts';
import { agentName, fnLabel } from '../logic/labels.ts';
import { drawerRun, recordIsBehind } from '../logic/runs.ts';
import { useChatUrl } from '../url.ts';
import ThreadPane from './ThreadPane.vue';
import FnModal from '../../fns/components/FnModal.vue';
import ModelPicker from '../components/ModelPicker.vue';
import SessionPeople from '../components/SessionPeople.vue';
import { modelChoiceOf, modelPick, type ModelPick } from '../logic/session.ts';
import type { ChatPanel } from '../url.ts';

/** Each chat panel's title. */
const PANEL_TITLE = { settings: 'Chat settings', people: 'People', model: 'Model' } as const satisfies Record<ChatPanel, string>;

const { chat, toasts, session: auth, layout } = useStores();
const router = useRouter();
/** Context was made from the resource in the panel: say so, with a way to open it. */
const contextMade = (made: readonly QualifiedName[]): void => { toastContextMade(toasts, made, (name) => { void router.push(links.contextItem(name)); }); };
/** The shell's top bar is hidden on a chat when the screen is compact: the chat's header takes its place. */
const shellCompact = useMediaQuery(COMPACT_QUERY);
const url = useChatUrl();
const query = useRouteQuery(ROUTES.session);
const runTab = query.choice(TAB_KEYS.run, RunTab, 'overview');
const callTab = query.choice(TAB_KEYS.llm, LlmCallTab, 'saw');
const wide = useMediaQuery('(min-width: 1100px)');
const roomy = useMediaQuery('(min-width: 1360px)');
const spacious = useMediaQuery('(min-width: 1720px)');
/** Panels open as sheets and the list is its own page: the compact shell's screens (narrow, or short like a phone on its side). */
const phone = shellCompact;

const listOpen = ref(false);
const shortcutsOpen = ref(false);
const list = ref<SessionListHandle | null>(null);
const pane = ref<{ focusComposer: () => void } | null>(null);
const sessions = chat.sessions;

// the list's search and view, read from the URL and written back to it
watch(url.search, (text) => { if (text !== sessions.search.value.trim()) { sessions.setSearch(text); } }, { immediate: true });
watch(url.archived, (archived) => { if (archived !== sessions.archived.value) { void sessions.showArchived(archived); } }, { immediate: true });
function search(text: string): void {
  sessions.setSearch(text);
  url.setList({ search: text });
}
function showArchived(archived: boolean): void {
  void sessions.showArchived(archived);
  url.setList({ archived });
}

const thread = computed(() => (url.session.value === undefined ? undefined : chat.thread(url.session.value)));
/** The fn looked into from a run (its modal), and the thread's runs in call order for its runs here. */
const fnOpen = ref<QualifiedName | undefined>(undefined);
const threadRuns = computed(() => [...(thread.value?.runs.value.values() ?? [])]);
const record = computed(() => thread.value?.session.value);
/** The open chat's dry run of its contextor, for its settings. */
const preview = computed(() => (url.session.value === undefined ? undefined : chat.preview(url.session.value)));
const previewView = computed(() => ({
  report: preview.value?.report.value.value, loading: preview.value?.report.loading.value ?? false, problem: preview.value?.report.problem.value ?? '',
}));

// ── the list ─────────────────────────────────────────────────────────────────

async function create(): Promise<void> {
  const made = await sessions.create();
  if (made === undefined) { toasts.error("Couldn't start a chat", sessions.problem.value); return; }
  listOpen.value = false;
  url.go(made);
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

/** The chat waiting for the person to confirm its deletion. */
const deleting = shallowRef<SessionId | undefined>(undefined);
const deletingOpen = computed({ get: () => deleting.value !== undefined, set: (open) => { if (!open) { deleting.value = undefined; } } });
const deletingTitle = computed(() => (deleting.value === undefined ? '' : (sessions.find(deleting.value)?.title ?? thread.value?.session.value?.title ?? 'this chat')));
const removing = ref(false);

function askRemove(id: SessionId): void {
  deleting.value = id;
}

/** Delete the chat being confirmed; leaving it when it is the one open. */
async function remove(): Promise<void> {
  const id = deleting.value;
  if (id === undefined) { return; }
  removing.value = true;
  const done = await sessions.remove(id);
  removing.value = false;
  deleting.value = undefined;
  if (!done) { toasts.error("Couldn't delete that chat", sessions.problem.value); return; }
  toasts.ok('Chat deleted');
  if (url.session.value === id) { url.go(undefined); }
}

/** The list's state and moves, the same wherever it is drawn (its column, the drawer, the page on a phone). */
const listBind = computed(() => ({
  items: sessions.listed(url.session.value), search: sessions.search.value, archived: sessions.archived.value, loading: sessions.loading.value, loaded: sessions.loaded.value,
  problem: sessions.problem.value, hasMore: sessions.hasMore.value, partial: sessions.partial.value, loadingMore: sessions.loadingMore.value, creating: sessions.creating.value, now: now.value,
}));
const listOn = {
  open, create, search, archived: showArchived, rename, archive, remove: askRemove, more: () => { void sessions.loadMore(); }, retry: () => { void sessions.load(); },
};

function step(by: number): void {
  const items = sessions.items.value;
  const at = items.findIndex((s) => s.id === url.session.value);
  const next = items[Math.max(0, Math.min(items.length - 1, at + by))];
  if (next !== undefined && next.id !== url.session.value) { url.go(next.id); }
}

// ── panels ───────────────────────────────────────────────────────────────────

const panelOpen = computed({ get: () => url.top.value !== undefined, set: (open) => { if (!open) { url.close(); } } });
/** The list has its own column: wide screens, unless a side panel needs that room. */
const listColumn = computed(() => wide.value && !phone.value && (!(roomy.value && panelOpen.value) || spacious.value));
const compact = computed(() => !listColumn.value);
/** The window's width, which caps how wide a panel may be. */
const viewport = shallowRef(typeof window === 'undefined' ? 1440 : window.innerWidth);
const measureViewport = (): void => { viewport.value = window.innerWidth; };
const panelMax = computed(() => panelWidthMax(viewport.value));
/** The open panel's kind, whose width it keeps: its key, and for `?panel=` which one (settings, people, model). */
const panelKind = computed(() => (url.top.value === 'panel' && url.panel.value !== undefined ? `panel:${url.panel.value}` : url.top.value));
/** The open panel's width: each kind of panel its own, saved; shown within the window's limits. */
const panelWidth = computed({
  get: () => panelWidthIn(panelKind.value === undefined ? PANEL_WIDTH.reset : layout.panelWidth(panelKind.value), viewport.value),
  set: (width: number) => { if (panelKind.value !== undefined) { layout.setPanelWidth(panelKind.value, width); } },
});
const runView = computed(() => {
  const id = url.run.value;
  if (id === undefined) { return undefined; }
  const live = thread.value?.runs.value.get(id);
  const fetched = chat.inspector.run.value.value;
  return drawerRun(live, fetched?.id === id ? fetched : undefined);
});
/** Ticks every second while the open run is going, so its drawer's elapsed time counts up. */
const now = useTicker(() => runView.value !== undefined && !isSettled(runView.value.status));
const llmCall = computed(() => (url.llm.value === undefined ? undefined : chat.inspector.calls.value.get(url.llm.value)));
const turnCalls = shallowRef<readonly LlmInteraction[]>([]);
const turnLoading = ref(false);

const panelTitle = computed(() => {
  switch (url.top.value) {
    case 'run': return runView.value === undefined ? 'Run' : fnLabel(runView.value.fn);
    case 'llm': return 'LLM call';
    case 'details': return 'Answer details';
    case 'tree': return 'Run tree';
    case 'resource': return chat.inspector.resource.value.value?.stat.name ?? 'Resource';
    case 'panel': return url.panel.value === undefined ? '' : PANEL_TITLE[url.panel.value];
    case undefined: return '';
  }
});
const panelSubtitle = computed(() => {
  switch (url.top.value) {
    case 'run': return runView.value?.fn ?? '';
    case 'llm': return llmCall.value?.model ?? '';
    case 'resource': return url.resource.value ?? '';
    case 'details': case 'tree': case 'panel': case undefined: return '';
  }
});

watch(url.run, (id) => { if (id !== undefined) { void chat.inspector.openRun(id); } }, { immediate: true });
// once the thread hears the open run settle, fetch its record again for the result and errors
watch(() => (url.run.value === undefined ? undefined : thread.value?.runs.value.get(url.run.value)), (live) => {
  if (recordIsBehind(live, chat.inspector.run.value.value) && live !== undefined) { void chat.inspector.openRun(live.id); }
});
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

/** Save the chat's model and go back to where the picker was opened from. */
async function pickModel(pick: ModelPick): Promise<void> {
  if (thread.value === undefined) { return; }
  await thread.value.update({ model: modelChoiceOf(pick) });
  url.close();
}

/** A link inside the opened resource that points at another resource opens it in the panel. */
function openLinked(uri: string): void {
  const parsed = ResourceUri.safeParse(uri);
  if (parsed.success) { url.open('resource', parsed.data); }
}

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
  window.addEventListener('resize', measureViewport);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', measureViewport);
  chat.leave();
});
</script>

<template>
  <div class="chat" :class="{ compact, roomy: roomy && panelOpen }" :style="{ '--panel': `${panelWidth}px` }" data-testid="chat">
    <aside v-if="listColumn" class="list">
      <SessionList ref="list" v-bind="listBind" :current="url.session.value" :home-shown="url.session.value === undefined && !phone" v-on="listOn" />
    </aside>
    <UiModal v-else-if="url.session.value !== undefined" v-model:open="listOpen" placement="left" label="Chats" width="320px">
      <SessionList ref="list" v-bind="listBind" :current="url.session.value" v-on="listOn" />
    </UiModal>

    <main class="main">
      <ThreadPane
        v-if="url.session.value" ref="pane" :key="url.session.value" :session="url.session.value" :compact="compact" :narrow="roomy && panelOpen" :nav="shellCompact" :flash="url.message.value"
        :debug="url.debug.value" @debug="url.setDebug($event)"
        @run="url.open('run', $event)" @llm="url.open('llm', $event)" @details="url.open('details', $event)" @tree="url.openTree($event)"
        @resource="url.open('resource', $event)" @panel="url.open('panel', $event)" @sessions="listOpen = true" @nav="layout.drawerOpen.value = true" @new-chat="create"
        @message="showMessage" @shortcuts="shortcutsOpen = true" @remove="url.session.value && askRemove(url.session.value)"
      />
      <SessionList v-else-if="phone" ref="list" class="home-list" v-bind="listBind" v-on="listOn" />
      <div v-else class="start" :class="{ split: compact }">
        <SessionList v-if="compact" ref="list" class="home-list side-list" v-bind="listBind" home-shown v-on="listOn" />
        <UiEmpty class="home" icon="chat" tone="accent" title="Start a conversation" body="Chat with your agent, and run the fns your connected systems offer." data-testid="chat-home">
          <!-- the list beside it already has New chat: the empty state offers its own only when no list shows -->
          <template v-if="!listColumn && !compact" #actions><UiButton variant="primary" icon="plus" :loading="sessions.creating.value" @click="create">New chat</UiButton></template>
        </UiEmpty>
      </div>
    </main>

    <PanelHost v-if="url.session.value !== undefined" v-model:open="panelOpen" v-model:width="panelWidth" :max="panelMax" :inline="roomy && !phone" :phone="phone" :label="panelTitle" :data-panel="url.top.value">
      <PanelFrame :title="panelTitle" :subtitle="panelSubtitle" @close="url.close()">
        <RunDetails
          v-if="url.top.value === 'run'" v-model:tab="runTab" :run="runView" :record="chat.inspector.run.value.value" :loading="chat.inspector.run.loading.value"
          :problem="chat.inspector.run.problem.value" :now="now" :args-type="runView && chat.capabilities.invocation(runView.fn)?.args" :can-see-calls="auth.user.value?.role === 'admin'" @background="backgroundRun"
          @tree="runView?.turn && url.openTree(runView.turn)" @undo="undoRunTurn" @llm="url.open('llm', $event)"
          @run="url.open('run', $event)" @retry="url.run.value && chat.inspector.openRun(url.run.value)" @calls="router.push(links.modelCalls({ run: $event }))"
          @fn="fnOpen = $event"
        />
        <TurnTree
          v-else-if="url.top.value === 'tree'" :tree="chat.inspector.tree.value.value" :loading="chat.inspector.tree.loading.value" :problem="chat.inspector.tree.problem.value"
          :live="liveStatus" @run="url.open('run', $event)" @llm="url.open('llm', $event)" @retry="url.treeTurn.value && chat.inspector.openTree(url.treeTurn.value)"
        />
        <template v-else-if="url.top.value === 'llm'">
          <LlmCallDetails v-if="llmCall" v-model:tab="callTab" :call="llmCall" />
          <p v-else class="dim">{{ (url.llm.value && chat.inspector.callProblems.value.get(url.llm.value)) || 'Loading…' }}</p>
        </template>
        <TurnDetails v-else-if="url.top.value === 'details'" :calls="turnCalls" :loading="turnLoading" :problem="chat.inspector.tree.problem.value" @llm="url.open('llm', $event)" />
        <ResourceViewer
          v-else-if="url.top.value === 'resource' && url.resource.value" :uri="url.resource.value" @navigate="openLinked"
          @notice="(text, tone) => (tone === 'ok' ? toasts.ok(text) : toasts.error(text))"
          @context="contextMade"
        />
        <SessionPeople v-else-if="url.top.value === 'panel' && url.panel.value === 'people' && record" :participants="record.participants" :name-of="nameOf" />
        <ModelPicker
          v-else-if="url.top.value === 'panel' && url.panel.value === 'model' && record && thread" :models="chat.capabilities.value.value?.models ?? []"
          :current="modelPick(record.model)" @pick="pickModel"
        />
        <SessionSettings
          v-else-if="url.top.value === 'panel' && record && thread" :session="record" :systems="chat.capabilities.value.value?.systems ?? []" :notify="thread.notify.value"
          :agent="agentName(record.agent)" :agents="chat.capabilities.value.value?.agents ?? []" :models="chat.capabilities.value.value?.models ?? []"
          :priority="thread.limits.value?.priority" :name-of="nameOf" :preview="previewView" @notify="thread.update({ notify: $event })" @systems="thread.update({ systems: $event })"
          @priority="thread.update({ priority: $event })" @agent="thread.update({ agent: $event })" @pick-model="url.open('panel', 'model')"
          @mode="thread.update({ mode: $event })" @contextor="thread.update({ contextor: $event })" @preview="preview?.preview($event)"
        />
      </PanelFrame>
    </PanelHost>

    <ShortcutsDialog v-model:open="shortcutsOpen" />
    <FnModal
      v-if="fnOpen" v-model:fn="fnOpen" :runs="threadRuns" :can-open-page="auth.user.value?.role === 'admin'" :manage="auth.user.value?.role === 'admin'"
      @run="(id) => { fnOpen = undefined; url.open('run', id); }" @page="router.push(links.fn($event))"
    />
    <ConfirmDialog
      v-model:open="deletingOpen" :title="`Delete “${deletingTitle}”?`" confirm="Delete chat" :busy="removing" data-testid="confirm-delete"
      body="Its messages and what its fns kept in this chat go for good. Work still running in it is stopped. Changes fns already made stay."
      @confirm="remove"
    />
  </div>
</template>

<style scoped>
/* exactly the page's height, and never a scroll container itself (clip, not hidden: bringing a field into view can't scroll it), so only the thread and a panel's body scroll */
.chat { display: grid; grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; min-height: 0; overflow: clip; }
.chat.compact { grid-template-columns: minmax(0, 1fr); }
.chat.roomy { grid-template-columns: 300px minmax(0, 1fr) var(--panel); }
.chat.compact.roomy { grid-template-columns: minmax(0, 1fr) var(--panel); }
.list { min-height: 0; border-right: 1px solid var(--border); background: var(--surface); }
.main { position: relative; min-width: 0; min-height: 0; }
.home { height: 100%; align-content: center; }
.home-list { height: 100%; }
/* a tablet with no chat open: the list at its usual width, and a way to start beside it */
.start { height: 100%; }
.split { display: grid; grid-template-columns: 300px minmax(0, 1fr); }
.side-list { border-right: 1px solid var(--border); background: var(--surface); }
.dim { margin: 0; color: var(--text-faint); }
</style>
