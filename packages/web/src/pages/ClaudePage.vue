<script setup lang="ts">
/**
 * The Claude fleet (`/claude`, build 9): the person's Claude Code sessions on every machine, from the hub's
 * `claude/Session` records, searched by words and filtered by machine, folder and status, all in the URL, newest change
 * first and read again while the page is open. A session that waits on the person says so. New session (`?new=1`)
 * asks for a folder and what to do, starts it as the person's run, answers its approval in the dialog when it asks
 * first, then opens the session.
 */
import { ClaudeSessionStatus, type Json, type Remember } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { useLive } from '../app/live.ts';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import ClaudeSessionList from '../claude/components/ClaudeSessionList.vue';
import NewSessionForm from '../claude/components/NewSessionForm.vue';
import { choicesOf, folderName, STATUS_OPTIONS, startDraft, type FleetSession, type FleetUrl, type StartDraft } from '../claude/logic/claude.ts';
import { ClaudeFleet, ClaudeStarter } from '../claude/state/fleet.ts';
import ApprovalCard from '../components/approvals/ApprovalCard.vue';
import { isRememberable } from '../components/approvals/rules.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiDialog, UiEmpty, UiInput, UiSelect, type SelectOption } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

/** How often the list is read again while the page is open (ms). */
const REFRESH = 5_000;

const { data, chat, toasts } = useStores();
const router = useRouter();
const query = useRouteQuery(ROUTES.claude);
const words = query.draft('q');
const machine = query.text('machine');
const folder = query.text('folder');
const statusText = query.text('status');
const adding = query.text('new', { push: true });
const now = useNow();

const fleet = new ClaudeFleet(data);
const status = computed(() => { const parsed = ClaudeSessionStatus.safeParse(statusText.value); return parsed.success ? parsed.data : undefined; });
const url = computed((): FleetUrl => ({
  ...(words.value.value === '' ? {} : { q: words.value.value }), ...(machine.value === '' ? {} : { machine: machine.value }),
  ...(folder.value === '' ? {} : { folder: folder.value }), ...(status.value === undefined ? {} : { status: status.value }),
}));
watch(() => JSON.stringify(url.value), () => { void fleet.show(url.value); }, { immediate: true });
useLive(() => { void fleet.refresh(); }, REFRESH);

const sessions = computed(() => fleet.items.value);
const filtered = computed(() => Object.keys(url.value).length > 0);
const machines = computed((): SelectOption<string>[] => [{ value: '', label: 'Machine' }, ...choicesOf(sessions.value, 'instance', machine.value).map((name) => ({ value: name, label: name }))]);
const folders = computed((): SelectOption<string>[] => [{ value: '', label: 'Folder' }, ...choicesOf(sessions.value, 'folder', folder.value).map((path) => ({ value: path, label: folderName(path) }))]);
const statusModel = computed({ get: () => status.value ?? '', set: (next: string) => { statusText.value = next; } });
const linkOf = (item: FleetSession) => links.claudeSession(item.value.instance, item.value.session);

function clear(): void {
  void router.replace(links.claude());
}

// ── a new session ─────────────────────────────────────────────────────────────

const starter = new ClaudeStarter(chat);
const draft = ref<StartDraft>(startDraft(folder.value, machine.value));
const dialogOpen = computed({ get: () => adding.value === '1', set: (open: boolean) => { adding.value = open ? '1' : ''; } });
watch(dialogOpen, (open) => { if (open) { draft.value = startDraft(folder.value, machine.value); } else { starter.close(); } });
onBeforeUnmount(() => { starter.close(); });

/** The start's own approval (it is a write), answered here. */
const startApproval = computed(() => starter.runs.value?.thread.value?.approvals.value[0]);
const usedFolders = computed(() => choicesOf(sessions.value, 'folder', ''));
const usedMachines = computed(() => choicesOf(sessions.value, 'instance', ''));

async function start(): Promise<void> {
  const started = await starter.start(draft.value);
  if (started === undefined) {
    if (starter.problem.value !== '') { toasts.error("Couldn't start the session", starter.problem.value); }
    return;
  }
  toasts.ok('Session started');
  await router.push(links.claudeSession(started.instance, started.session));
}

async function decideStart(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<void> {
  const thread = starter.runs.value?.thread.value;
  const approval = startApproval.value;
  if (thread === undefined || approval === undefined) { return; }
  if (!(await thread.approve(approval.id, approve, remember, reason, answer))) { toasts.error("Couldn't send your answer", thread.problem.value); }
}
</script>

<template>
  <AppPage title="Claude" description="Your Claude Code sessions on every machine: what each is doing, and what waits on you.">
    <template #actions>
      <UiButton variant="primary" icon="plus" data-testid="claude-new" @click="dialogOpen = true">New session</UiButton>
    </template>

    <div class="filters" data-testid="claude-filters">
      <UiInput v-model="words.draft.value" class="words" label="Search sessions" hide-label icon="search" placeholder="Search titles, folders and answers" clearable />
      <UiSelect v-model="machine" :options="machines" label="Machine" hide-label size="sm" />
      <UiSelect v-model="folder" :options="folders" label="Folder" hide-label size="sm" />
      <UiSelect v-model="statusModel" :options="STATUS_OPTIONS" label="Status" hide-label size="sm" />
    </div>

    <LoadState :loading="fleet.loading.value" :problem="fleet.problem.value" :ready="fleet.loaded.value" :empty="sessions.length === 0" @retry="fleet.show(url)">
      <ClaudeSessionList :sessions="sessions" :link-of="linkOf" :now="now" />
      <div v-if="fleet.hasMore.value" class="more">
        <UiButton variant="ghost" size="sm" :loading="fleet.loadingMore.value" data-testid="claude-more" @click="fleet.more()">Show more</UiButton>
      </div>
      <template #empty>
        <UiEmpty v-if="filtered" icon="search" title="No sessions match" body="Try other words, or clear the filters.">
          <template #actions><UiButton variant="secondary" @click="clear">Clear filters</UiButton></template>
        </UiEmpty>
        <UiEmpty v-else icon="code" title="No Claude sessions yet" body="Start one in a folder on a machine; it shows here with what it is doing and what it needs from you.">
          <template #actions><UiButton variant="primary" icon="plus" @click="dialogOpen = true">New session</UiButton></template>
        </UiEmpty>
      </template>
    </LoadState>

    <UiDialog v-model:open="dialogOpen" title="New Claude session" description="It starts in the folder and works on its own; you answer what it asks." width="600px">
      <div class="dialog" data-testid="claude-new-dialog">
        <NewSessionForm v-model="draft" :folders="usedFolders" :machines="usedMachines" :problems="starter.problems.value" :disabled="starter.busy.value" />
        <ApprovalCard
          v-if="startApproval" :ident="startApproval.id" :fn="startApproval.fn" description="Starting a session runs Claude Code on the machine." :args="undefined"
          :preview="startApproval.preview" :rememberable="isRememberable(startApproval)" :ask="startApproval.ask" @decide="decideStart"
        />
        <p v-else-if="starter.phase.value === 'starting'" class="status">Starting the session…</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="dialogOpen = false">Cancel</UiButton>
        <UiButton variant="primary" icon="play" :loading="starter.busy.value" data-testid="claude-start" @click="start">Start</UiButton>
      </template>
    </UiDialog>
  </AppPage>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4); }
.filters > * { flex: 1 1 140px; min-width: 0; max-width: 220px; }
@media (max-width: 759.98px) { .filters > * { max-width: none; } }
.filters > .words { flex: 1 1 320px; max-width: none; }
.more { display: flex; justify-content: center; padding-top: var(--space-3); }
.dialog { display: grid; gap: var(--space-4); min-width: 0; }
.status { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
