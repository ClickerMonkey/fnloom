<script setup lang="ts">
/**
 * The Claude fleet (`/s/claude/sessions`): the person's Claude Code sessions on every machine, from the hub's
 * `claude/Session` records, searched by words and filtered by machine, folder and status in the hub's database, all in
 * the URL, newest change first and read again while the page is open. A session that waits on the person says so.
 * New session (`?new=1`) asks for a folder and what to do, starts it as the person's run, answers its approval in the
 * dialog when it asks first, then opens the session.
 */
import type { Json, Remember } from '@harness/core';
import type { PageViewOf, SelectChoice } from '@harness/sdk';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { CLAUDE_PAGES, type ClaudeContract } from '../shared/index.ts';
import NewSessionForm from './NewSessionForm.vue';
import SessionList from './SessionList.vue';
import { choicesOf, fleetUrl, folderName, STATUS_CHOICES, startDraft, type StartDraft } from './logic.ts';
import { ClaudeFleet, ClaudeStarter } from './state.ts';

/** How often the list is read again while the page is open (ms). */
const REFRESH = 5_000;
/** How long typing rests before the words go to the URL and the hub (ms). */
const SETTLE = 250;

const view = defineProps<PageViewOf<ClaudeContract>>();
const host = view.host;
const { Frame, Input, Select, Button, LoadState, Empty, Dialog, Approval } = host.components;

const url = computed(() => fleetUrl(host.query.values));
const machine = host.query.bind('machine');
const folder = host.query.bind('folder');
const status = host.query.bind('status');

/** The words as typed: they reach the URL (and the hub) once typing rests, and follow the URL when it changes. */
const words = ref(url.value.q ?? '');
let settle: ReturnType<typeof setTimeout> | undefined;
watch(words, (next) => {
  clearTimeout(settle);
  settle = setTimeout(() => { host.query.set({ q: next.trim() }); }, SETTLE);
});
watch(() => url.value.q ?? '', (next) => { if (next !== words.value.trim()) { words.value = next; } });

const now = ref(Date.now());
const fleet = new ClaudeFleet(host.hub);
watch(() => JSON.stringify({ ...url.value, new: undefined }), () => { void fleet.show(url.value); }, { immediate: true });
host.live(() => { now.value = Date.now(); void fleet.refresh(); }, REFRESH);

const sessions = computed(() => fleet.items.value);
const filtered = computed(() => url.value.q !== undefined || url.value.machine !== undefined || url.value.folder !== undefined || url.value.status !== undefined);
const machines = computed((): SelectChoice[] => [{ value: '', label: 'Any machine' }, ...choicesOf(sessions.value, 'instance', url.value.machine).map((name) => ({ value: name, label: name }))]);
const folders = computed((): SelectChoice[] => [{ value: '', label: 'Any folder' }, ...choicesOf(sessions.value, 'folder', url.value.folder).map((path) => ({ value: path, label: folderName(path) }))]);

function clear(): void {
  words.value = '';
  host.query.set({ q: undefined, machine: undefined, folder: undefined, status: undefined });
}

// ── a new session ─────────────────────────────────────────────────────────────

const starter = new ClaudeStarter((options) => host.runs(options));
const draft = ref<StartDraft>(startDraft(url.value.folder, url.value.machine));
const dialogOpen = computed({ get: () => url.value.new === '1', set: (open: boolean) => { host.query.set({ new: open ? '1' : undefined }, { push: open }); } });
watch(dialogOpen, (open) => { if (open) { draft.value = startDraft(url.value.folder, url.value.machine); } else { starter.close(); } });
onBeforeUnmount(() => { starter.close(); clearTimeout(settle); });

const usedFolders = computed(() => choicesOf(sessions.value, 'folder', undefined));
const usedMachines = computed(() => choicesOf(sessions.value, 'instance', undefined));

async function start(): Promise<void> {
  const started = await starter.start(draft.value);
  if (started === undefined) {
    if (starter.problem.value !== '') { host.notify.error("Couldn't start the session", starter.problem.value); }
    return;
  }
  host.notify.ok('Session started');
  host.go({ page: CLAUDE_PAGES.session, path: [started.instance, started.session], query: {} });
}

async function decideStart(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<void> {
  if (!(await starter.decide(approve, remember, reason, answer))) { host.notify.error("Couldn't send your answer", starter.problem.value); }
}
</script>

<template>
  <Frame title="Claude" description="Your Claude Code sessions on every machine: what each is doing, and what waits on you." keep-title>
    <template #actions>
      <Button variant="primary" icon="plus" data-testid="claude-new" @click="dialogOpen = true">New session</Button>
    </template>

    <div class="filters" data-testid="claude-filters">
      <Input v-model="words" class="words" type="search" label="Search sessions" hide-label icon="search" placeholder="Search titles, folders and answers" clearable />
      <Select v-model="machine.value" :options="machines" label="Machine" hide-label />
      <Select v-model="folder.value" :options="folders" label="Folder" hide-label />
      <Select v-model="status.value" :options="STATUS_CHOICES" label="Status" hide-label />
    </div>

    <LoadState :loading="fleet.loading.value" :problem="fleet.problem.value" :ready="fleet.loaded.value" :empty="sessions.length === 0" @retry="fleet.show(url)">
      <SessionList :sessions="sessions" :now="now" />
      <div v-if="fleet.hasMore.value" class="more">
        <Button variant="ghost" size="sm" :loading="fleet.loadingMore.value" data-testid="claude-more" @click="fleet.more()">Show more</Button>
      </div>
      <template #empty>
        <Empty v-if="filtered" icon="search" title="No sessions match" body="Try other words, or clear the filters.">
          <template #actions><Button variant="secondary" @click="clear">Clear filters</Button></template>
        </Empty>
        <Empty v-else icon="code" title="No Claude sessions yet" body="Start one in a folder on a machine; it shows here with what it is doing and what it needs from you.">
          <template #actions><Button variant="primary" icon="plus" @click="dialogOpen = true">New session</Button></template>
        </Empty>
      </template>
    </LoadState>

    <Dialog v-model:open="dialogOpen" title="New Claude session" description="It starts in the folder and works on its own; you answer what it asks." width="600px">
      <div class="dialog" data-testid="claude-new-dialog">
        <NewSessionForm v-model="draft" :folders="usedFolders" :machines="usedMachines" :problems="starter.problems.value" :disabled="starter.busy.value" />
        <Approval v-if="starter.approval.value" :approval="starter.approval.value" in-chat description="Starting a session runs Claude Code on the machine." @decide="decideStart" />
        <p v-else-if="starter.phase.value === 'starting'" class="status">Starting the session…</p>
      </div>
      <template #footer>
        <Button variant="ghost" @click="dialogOpen = false">Cancel</Button>
        <Button variant="primary" icon="play" :loading="starter.busy.value" data-testid="claude-start" @click="start">Start</Button>
      </template>
    </Dialog>
  </Frame>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4); }
.filters > * { flex: 1 1 140px; min-width: 0; max-width: 220px; }
.filters > .words { flex: 1 1 320px; max-width: none; }
@media (max-width: 759.98px) { .filters > * { max-width: none; } }
.more { display: flex; justify-content: center; padding-top: var(--space-3); }
.dialog { display: grid; gap: var(--space-4); min-width: 0; }
.status { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
