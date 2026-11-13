<script setup lang="ts">
/**
 * One Claude session (`/claude/:instance/:session`, build 9): where it works and how it is set, what waits on the
 * person (its approvals and questions as cards answered right here; they also show in its chat, linked from its facts, and the inbox), its
 * transcript (a subagent's own with `?task=`), its tasks and workflows with their progress, and a message box. Interrupt,
 * Stop and the permission mode act on it as the person's runs in the session's chat. Read again while the page is open.
 */
import { ClaudeSessionId, InstanceName, type ClaudeControl, type ClaudePermissionMode, type Json, type Remember } from '@harness/core';
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { useLive } from '../app/live.ts';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import StatusBadge from '../admin/components/StatusBadge.vue';
import ClaudeComposer from '../claude/components/ClaudeComposer.vue';
import ClaudeTaskList from '../claude/components/ClaudeTaskList.vue';
import ClaudeTranscript from '../claude/components/ClaudeTranscript.vue';
import { folderName, isLive, MODE_OPTIONS, statusLook, taskTree } from '../claude/logic/claude.ts';
import { ClaudeSessionStore, type WaitingCard } from '../claude/state/session.ts';
import ApprovalCard from '../components/approvals/ApprovalCard.vue';
import { isRememberable } from '../components/approvals/rules.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiButton, UiEmpty, UiSelect, UiSkeleton, fullTime, relativeTime } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

/** How often the session is read again while the page is open (ms). */
const REFRESH = 3_000;

const { data, chat, toasts } = useStores();
const route = useRoute();
const query = useRouteQuery(ROUTES.claudeSession);
const task = query.text('task');
const now = useNow();

const param = (name: string): string => { const value = route.params[name]; return typeof value === 'string' ? value : ''; };
const store = shallowRef<ClaudeSessionStore | undefined>(undefined);
watch(() => [param('instance'), param('session'), task.value] as const, ([rawInstance, rawSession, agent]) => {
  store.value?.close();
  const instance = InstanceName.safeParse(rawInstance);
  const session = ClaudeSessionId.safeParse(rawSession);
  if (!instance.success || !session.success) { store.value = undefined; return; }
  const next = new ClaudeSessionStore({ data, chat, desk: chat.approvals }, { instance: instance.data, session: session.data }, agent === '' ? undefined : agent);
  store.value = next;
  void next.open();
}, { immediate: true });
onBeforeUnmount(() => { store.value?.close(); });
useLive(() => { void store.value?.refresh(); }, REFRESH);

const record = computed(() => store.value?.record.value?.value);
const title = computed(() => record.value?.title || (record.value === undefined ? 'Claude session' : folderName(record.value.folder)));
const live = computed(() => record.value !== undefined && isLive(record.value.status));
const tasks = computed(() => taskTree(record.value?.tasks ?? []));
const openTask = computed(() => record.value?.tasks.find((t) => t.id === task.value));
const waiting = computed(() => store.value?.waiting.value ?? []);
const transcriptOf = (id: string) => links.claudeSession(param('instance'), param('session'), task.value === id ? {} : { task: id });
const mode = computed({
  get: () => record.value?.permissionMode ?? 'default',
  set: (next: ClaudePermissionMode) => { if (next !== record.value?.permissionMode) { void act('mode', next); } },
});
const composerHint = computed(() => {
  if (record.value === undefined) { return ''; }
  if (record.value.status === 'closed' || record.value.status === 'failed') { return 'Sending resumes the session.'; }
  return record.value.status === 'working' ? 'Claude reads it after the current step.' : 'Ctrl+Enter sends.';
});

async function act(action: ClaudeControl['action'], next?: ClaudePermissionMode): Promise<void> {
  const current = store.value;
  if (current === undefined) { return; }
  if (await current.control(action, next)) { toasts.ok(next !== undefined ? `Mode: ${MODE_OPTIONS.find((o) => o.value === next)?.label ?? next}` : action === 'stop' ? 'Session stopped' : 'Interrupted'); }
  else { toasts.error(action === 'mode' ? "Couldn't switch the mode" : action === 'stop' ? "Couldn't stop it" : "Couldn't interrupt it", current.problem.value); }
}

async function send(text: string, done: (sent: boolean) => void): Promise<void> {
  const current = store.value;
  if (current === undefined) { done(false); return; }
  const sent = await current.send(text);
  done(sent);
  if (!sent) { toasts.error("Couldn't send it", current.problem.value); }
}

async function decide(card: WaitingCard, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<void> {
  const current = store.value;
  if (current === undefined) { return; }
  if (await current.decide(card, approve, remember, reason, answer)) { toasts.ok(card.approval.ask !== undefined && approve ? 'Answered' : approve ? 'Approved' : 'Denied'); }
  else { toasts.error("Couldn't send your answer", current.problem.value); }
}
</script>

<template>
  <AppPage :title="title" keep-title>
    <template #crumb><RouterLink :to="links.claude()">Claude</RouterLink></template>
    <template v-if="record" #actions>
      <span class="mode">
        <span class="mode-word" aria-hidden="true">Permissions</span>
        <UiSelect v-model="mode" :options="MODE_OPTIONS" label="Permission mode" hide-label size="sm" :disabled="store?.controlling.value ?? false" data-testid="claude-mode" />
      </span>
      <UiButton v-if="live" size="sm" variant="secondary" icon="pause" :disabled="!(store?.busy.value ?? false)" :loading="store?.controlling.value ?? false" data-testid="claude-interrupt" @click="act('interrupt')">Interrupt</UiButton>
      <UiButton v-if="live" size="sm" variant="secondary" icon="stop" data-testid="claude-stop" @click="act('stop')">Stop</UiButton>
    </template>

    <UiSkeleton v-if="store?.loading.value" shape="lines" :lines="6" />
    <UiEmpty v-else-if="store?.missing.value" icon="search" title="No such session of yours" body="It may be on another machine, or belong to someone else.">
      <template #actions><RouterLink :to="links.claude()">Back to your sessions</RouterLink></template>
    </UiEmpty>
    <UiBanner v-else-if="record === undefined" tone="danger">{{ store?.problem.value || "Couldn't read this session." }}</UiBanner>

    <div v-else class="session" data-testid="claude-session">
      <div class="facts" data-testid="claude-facts">
        <StatusBadge :look="statusLook(record)" />
        <code class="folder" :title="record.folder">{{ record.folder }}</code>
        <span>{{ record.instance }}</span>
        <span v-if="record.model">{{ record.model }}</span>
        <span v-if="record.agent">as {{ record.agent }}</span>
        <span>{{ record.turns }} {{ record.turns === 1 ? 'turn' : 'turns' }}</span>
        <span>${{ record.costUsd.toFixed(2) }}</span>
        <span :title="fullTime(record.updatedAt)">{{ relativeTime(record.updatedAt, now) }}</span>
        <RouterLink v-if="record.chat" :to="links.session(record.chat)" data-testid="claude-chat">Open its chat</RouterLink>
      </div>
      <UiBanner v-if="record.problem" tone="danger">{{ record.problem }}</UiBanner>

      <section v-if="waiting.length > 0" class="waiting" aria-label="Waiting for you" data-testid="claude-waiting">
        <ApprovalCard
          v-for="card in waiting" :key="card.approval.id" :data-approval="card.approval.id" :ident="card.approval.id" :fn="card.approval.fn" description="" :args="undefined"
          :preview="card.approval.preview" :rememberable="card.inThread && isRememberable(card.approval)" :ask="card.approval.ask"
          @decide="(approve, remember, reason, answer) => decide(card, approve, remember, reason, answer)"
        />
      </section>
      <p v-else-if="store?.awaiting.value" class="note">
        Your run waits for approval in <RouterLink v-if="record.chat" :to="links.session(record.chat)">the session's chat</RouterLink><template v-else>the session's chat</template>.
      </p>

      <div class="body" :class="{ 'with-side': tasks.length > 0 }">
        <aside v-if="tasks.length > 0" class="side" aria-label="Tasks and workflows">
          <h2 class="heading">Tasks and workflows</h2>
          <ClaudeTaskList :nodes="tasks" :transcript-of="transcriptOf" :open="task" />
        </aside>
        <div class="main">
          <UiBanner v-if="task !== ''" tone="accent" data-testid="claude-task-banner">
            The transcript of {{ openTask?.name || openTask?.description || 'a subagent' }}.
            <template #actions><RouterLink :to="links.claudeSession(record.instance, record.session)">Main transcript</RouterLink></template>
          </UiBanner>
          <UiBanner v-if="store?.transcriptProblem.value" tone="danger">{{ store.transcriptProblem.value }}</UiBanner>
          <ClaudeTranscript
            v-if="store" :items="store.items.value" :more="store.older.value" :loading="store.transcriptLoading.value" @more="store.more()"
          />
          <p v-if="store && store.items.value.length === 0 && !store.transcriptLoading.value && !store.transcriptProblem.value" class="note">Nothing in the transcript yet.</p>
          <ClaudeComposer v-if="task === ''" :busy="store?.sending.value ?? false" :hint="composerHint" @send="send" />
        </div>
      </div>
    </div>
  </AppPage>
</template>

<style scoped>
.mode { display: inline-flex; align-items: center; gap: var(--space-2); }
.mode-word { color: var(--text-dim); font-size: var(--text-sm); white-space: nowrap; }
.session { display: grid; gap: var(--space-4); min-width: 0; }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); min-width: 0; color: var(--text-dim); font-size: var(--text-sm); }
.folder { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
.waiting { display: grid; gap: var(--space-3); min-width: 0; }
.body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); align-items: start; min-width: 0; }
.body.with-side { grid-template-columns: minmax(0, 1fr) minmax(240px, 320px); }
.main { display: grid; gap: var(--space-3); min-width: 0; grid-column: 1; grid-row: 1; }
.side { display: grid; gap: var(--space-3); min-width: 0; grid-column: 2; grid-row: 1; position: sticky; top: var(--space-4); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
/* on a phone the select says what it is by its value; the word would push Stop off the row */
@media (max-width: 559.98px) { .mode-word { display: none; } }
@media (max-width: 899.98px) {
  .body.with-side { grid-template-columns: minmax(0, 1fr); }
  .side { grid-column: 1; grid-row: 1; position: static; }
  .main { grid-row: 2; }
}
</style>
