<script setup lang="ts">
/**
 * One Claude session (`/s/claude/session/<instance>/<session>`): where it works and how it is set, what waits on the
 * person (its approvals and questions as cards answered right here; they also show in its chat and the inbox), its
 * transcript drawn with the chat's own parts (the person's messages as bubbles, Claude's turns as answers with their
 * reasoning folded and tool uses as run cards, a stretch of them folded into one section; a subagent's own with
 * `?task=`), its tasks and workflows with their progress, and the chat's composer pinned under it. Send, Stop
 * (interrupt), Stop session and the permission mode act on it as the person's runs in the session's chat, each
 * waiting for its run to settle with its outcome, so a send that went through is never reported as failed.
 */
import { InstanceName, type Json, type Remember, type SessionId } from '@harness/core';
import type { PageViewOf } from '@harness/sdk';
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { CLAUDE_PAGES, CLAUDE_SYSTEM, ClaudePermissionMode, ClaudeSessionId, asksPerson, type ClaudeContract, type ClaudeControl } from '../shared/index.ts';
import { plainClick } from './host.ts';
import TaskList from './TaskList.vue';
import { folderName, isLive, MODE_CHOICES, MODE_LABEL, statusLook, taskTree, transcriptEntries } from './logic.ts';
import { ClaudeSessionStore, type WaitingCard } from './state.ts';

/** How often the session is read again while the page is open (ms). */
const REFRESH = 3_000;

const view = defineProps<PageViewOf<ClaudeContract>>();
const host = view.host;
const { Frame, Badge, Banner, Button, Select, Empty, Skeleton, Approval, Conversation, Composer } = host.components;

const task = computed(() => host.query.get('task') ?? '');
const now = ref(Date.now());

const store = shallowRef<ClaudeSessionStore | undefined>(undefined);
const end = ref<HTMLElement | null>(null);
watch(() => [view.path[0] ?? '', view.path[1] ?? '', task.value] as const, ([rawInstance, rawSession, agent]) => {
  store.value?.close();
  const instance = InstanceName.safeParse(rawInstance);
  const session = ClaudeSessionId.safeParse(rawSession);
  if (!instance.success || !session.success) { store.value = undefined; return; }
  const next = new ClaudeSessionStore({ hub: host.hub, runs: (options) => host.runs(options), inbox: host.inbox }, { instance: instance.data, session: session.data }, agent === '' ? undefined : agent);
  store.value = next;
  // open at the newest: the end of the transcript, by the composer
  void next.open().then(() => nextTick(() => { end.value?.scrollIntoView({ block: 'end' }); }));
}, { immediate: true });
onBeforeUnmount(() => { store.value?.close(); });
host.live(() => { now.value = Date.now(); void store.value?.refresh(); }, REFRESH);

const record = computed(() => store.value?.record.value?.value);
const title = computed(() => record.value?.title || (record.value === undefined ? 'Claude session' : folderName(record.value.folder)));
const look = computed(() => (record.value === undefined ? undefined : statusLook(record.value)));
const live = computed(() => record.value !== undefined && isLive(record.value.status));
const tasks = computed(() => taskTree(record.value?.tasks ?? []));
const openTask = computed(() => record.value?.tasks.find((t) => t.id === task.value));
const waiting = computed(() => store.value?.waiting.value ?? []);
const entries = computed(() => transcriptEntries(store.value?.items.value ?? [], store.value?.busy.value ?? false));
/** The fleet, and this session's main transcript (a subagent's is open with `?task=`). */
const FLEET = { page: CLAUDE_PAGES.fleet, query: {} } as const;
const MAIN = computed(() => ({ query: { ...host.query.values, task: undefined } }));
const fleetHref = computed(() => host.href(FLEET));
const mainHref = computed(() => host.href(MAIN.value));
function toFleet(event: MouseEvent): void { if (plainClick(event)) { host.go(FLEET); } }
function toMain(event: MouseEvent): void { if (plainClick(event)) { host.go(MAIN.value); } }
function toChat(event: MouseEvent, chat: SessionId): void { if (plainClick(event)) { host.goChat(chat); } }

const mode = computed({
  get: (): string => record.value?.permissionMode ?? 'default',
  set: (next: string) => {
    const parsed = ClaudePermissionMode.safeParse(next);
    if (parsed.success && parsed.data !== record.value?.permissionMode) { void act('mode', parsed.data); }
  },
});
const composerNote = computed(() => {
  if (record.value === undefined) { return ''; }
  if (record.value.status === 'closed' || record.value.status === 'failed') { return 'Sending resumes the session.'; }
  return record.value.status === 'working' ? 'Claude reads it after the current step.' : '';
});

/** What the composer holds: it clears only once the message went. */
const text = ref('');

async function act(action: ClaudeControl['action'], next?: ClaudePermissionMode): Promise<void> {
  const current = store.value;
  if (current === undefined) { return; }
  if (await current.control(action, next)) { host.notify.ok(next !== undefined ? (asksPerson(next) ? `Approve ${MODE_LABEL[next]} on its card` : `Mode: ${MODE_LABEL[next]}`) : action === 'stop' ? 'Session stopped' : 'Interrupted'); }
  else { host.notify.error(action === 'mode' ? "Couldn't switch the mode" : action === 'stop' ? "Couldn't stop it" : "Couldn't interrupt it", current.problem.value); }
}

async function send(): Promise<void> {
  const current = store.value;
  const message = text.value.trim();
  if (current === undefined || message === '') { return; }
  const sent = await current.send(message);
  if (!sent) { host.notify.error("Couldn't send it", current.problem.value); return; }
  if (text.value.trim() === message) { text.value = ''; }
  await nextTick();
  end.value?.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

async function decide(card: WaitingCard, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<void> {
  const current = store.value;
  if (current === undefined) { return; }
  if (await current.decide(card, approve, remember, reason, answer)) { host.notify.ok(card.approval.ask !== undefined && approve ? 'Answered' : approve ? 'Approved' : 'Denied'); }
  else { host.notify.error("Couldn't send your answer", current.problem.value); }
}
</script>

<template>
  <Frame :title="title" keep-title width="full">
    <template #crumb><a :href="fleetHref" @click="toFleet">Claude</a></template>
    <template v-if="record" #actions>
      <span class="mode">
        <span class="mode-word" aria-hidden="true">Permissions</span>
        <Select v-model="mode" :options="MODE_CHOICES" label="Permission mode" hide-label size="sm" :disabled="store?.controlling.value ?? false" data-testid="claude-mode" />
      </span>
      <Button v-if="live" size="sm" variant="secondary" icon="stop" data-testid="claude-stop" @click="act('stop')">Stop session</Button>
    </template>

    <Skeleton v-if="store === undefined || store.loading.value" shape="lines" :lines="6" />
    <Empty v-else-if="store.missing.value" icon="search" title="No such session of yours" body="It may be on another machine, or belong to someone else.">
      <template #actions><a :href="fleetHref" @click="toFleet">Back to your sessions</a></template>
    </Empty>
    <Banner v-else-if="record === undefined" tone="danger">{{ store.problem.value || "Couldn't read this session." }}</Banner>

    <div v-else class="session" data-testid="claude-session">
      <div class="facts" data-testid="claude-facts">
        <Badge v-if="look" :tone="look.tone" dot :live="look.live" data-testid="status">{{ look.word }}</Badge>
        <code class="folder" :title="record.folder">{{ record.folder }}</code>
        <span>{{ record.instance }}</span>
        <span v-if="record.model">{{ record.model }}</span>
        <span v-if="record.agent">as {{ record.agent }}</span>
        <span>{{ record.turns }} {{ record.turns === 1 ? 'turn' : 'turns' }}</span>
        <span class="cost" title="What the session has cost">{{ host.format.cost(record.costUsd) }}</span>
        <span :title="host.format.fullTime(record.updatedAt)">{{ host.format.relativeTime(record.updatedAt, now) }}</span>
        <a v-if="record.chat" :href="host.chatHref(record.chat)" data-testid="claude-chat" @click="toChat($event, record.chat)">Open its chat</a>
      </div>
      <Banner v-if="record.problem" tone="danger">{{ record.problem }}</Banner>

      <section v-if="waiting.length > 0" class="waiting" aria-label="Waiting for you" data-testid="claude-waiting">
        <Approval
          v-for="card in waiting" :key="card.approval.id" :approval="card.approval" :in-chat="card.inChat"
          @decide="(approve: boolean, remember: Remember, reason: string, answer: Json | undefined) => decide(card, approve, remember, reason, answer)"
        />
      </section>
      <p v-else-if="store.awaiting.value" class="note">
        Your run waits for approval in <a v-if="record.chat" :href="host.chatHref(record.chat)" @click="toChat($event, record.chat)">the session's chat</a><template v-else>the session's chat</template>.
      </p>

      <div class="body" :class="{ 'with-side': tasks.length > 0 }">
        <aside v-if="tasks.length > 0" class="side" aria-label="Tasks and workflows">
          <h2 class="heading">Tasks and workflows</h2>
          <TaskList :nodes="tasks" :open="task" />
        </aside>
        <div class="main">
          <Banner v-if="task !== ''" tone="accent" data-testid="claude-task-banner">
            The transcript of {{ openTask?.name || openTask?.description || 'a subagent' }}.
            <template #actions><a :href="mainHref" @click="toMain">Main transcript</a></template>
          </Banner>
          <Banner v-if="store.transcriptProblem.value" tone="danger">{{ store.transcriptProblem.value }}</Banner>
          <div v-if="store.older.value || store.transcriptLoading.value" class="earlier">
            <Button size="sm" variant="ghost" icon="chevron-up" :loading="store.transcriptLoading.value" data-testid="transcript-more" @click="store.more()">Show earlier</Button>
          </div>
          <Conversation :entries="entries" :agent="'Claude'" :system="CLAUDE_SYSTEM" :streaming="store.busy.value" data-testid="claude-transcript" />
          <p v-if="entries.length === 0 && !store.transcriptLoading.value && !store.transcriptProblem.value" class="note">Nothing in the transcript yet.</p>
          <div ref="end" class="end" aria-hidden="true" />
          <div v-if="task === ''" class="dock" data-testid="claude-composer">
            <Composer
              v-model="text" placeholder="Message Claude" :sending="store.sending.value" :running="store.busy.value" :stopping="store.controlling.value" :note="composerNote"
              @send="send" @stop="act('interrupt')"
            />
          </div>
        </div>
      </div>
    </div>
  </Frame>
</template>

<style scoped>
.mode { display: inline-flex; align-items: center; gap: var(--space-2); }
.mode-word { color: var(--text-dim); font-size: var(--text-sm); white-space: nowrap; }
.session { display: grid; gap: var(--space-4); min-width: 0; }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); min-width: 0; color: var(--text-dim); font-size: var(--text-sm); }
.folder { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
.cost { font-variant-numeric: tabular-nums; }
.waiting { display: grid; gap: var(--space-3); min-width: 0; }
.body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); align-items: start; min-width: 0; }
.body.with-side { grid-template-columns: minmax(0, 1fr) minmax(240px, 320px); }
.main { display: grid; gap: var(--space-3); min-width: 0; grid-column: 1; grid-row: 1; max-width: 860px; width: 100%; justify-self: center; }
.side { display: grid; gap: var(--space-3); min-width: 0; grid-column: 2; grid-row: 1; position: sticky; top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.earlier { display: flex; justify-content: center; }
.end { height: 1px; }
/* the composer stays pinned under the transcript, as in the chat */
.dock { position: sticky; bottom: 0; z-index: 1; padding: var(--space-2) 0 var(--space-3); background: linear-gradient(to bottom, transparent, var(--bg) 30%); }
/* on a phone the select says what it is by its value; the word would push Stop off the row */
@media (max-width: 559.98px) { .mode-word { display: none; } }
@media (max-width: 899.98px) {
  .body.with-side { grid-template-columns: minmax(0, 1fr); }
  .side { grid-column: 1; grid-row: 1; position: static; }
  .main { grid-row: 2; }
}
</style>
