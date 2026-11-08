<script setup lang="ts">
/**
 * One open chat, wired to its stores: the header, the thread (messages, answers with their runs, notes, day
 * separators), the composer and everything around it (approvals and questions, the `!` form, background work,
 * suggestions while writing, the meta row). It turns what the person does into store calls and URL moves, and
 * leaves drawing to the components. Panels (a run, the tree, an LLM call) open through the URL, by emitting.
 */
import {
  ResourceUri, splitName, type Display, type QualifiedName, type ChatMessage, type Json, type Link, type LlmInteractionId, type MessageId, type MessagePart,
  type RunId, type SessionId, type TurnId,
} from '@harness/core';
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useStores } from '../../state/stores.ts';
import { copyText, UiButton, UiEmpty, UiPopover, UiSkeleton } from '../../ui/index.ts';
import { useTicker } from '../clock.ts';
import ApprovalTray from '../components/ApprovalTray.vue';
import AssistantAnswer from '../components/AssistantAnswer.vue';
import BackgroundStrip from '../components/BackgroundStrip.vue';
import BudgetCard from '../components/BudgetCard.vue';
import ChatHeader from '../components/ChatHeader.vue';
import ChatScroller from '../components/ChatScroller.vue';
import Composer from '../components/Composer.vue';
import ComposerMeta from '../components/ComposerMeta.vue';
import DraftSuggestions from '../components/DraftSuggestions.vue';
import HandlerCard from '../components/HandlerCard.vue';
import HoverCard from '../components/HoverCard.vue';
import InvocationForm from '../components/InvocationForm.vue';
import NoteRow from '../components/NoteRow.vue';
import PendingAnswer from '../components/PendingAnswer.vue';
import PendingMessage from '../components/PendingMessage.vue';
import Starters from '../components/Starters.vue';
import TurnNotice from '../components/TurnNotice.vue';
import type { ApprovalView, ComposerHandle, HeaderAction, MessageAction, RenderView, ScrollerHandle, Starter } from '../components/types.ts';
import UserMessage from '../components/UserMessage.vue';
import ConfirmDialog from '../../admin/components/ConfirmDialog.vue';
import { isTouch } from '../dom.ts';
import { GIN_INPUTS } from '../../gin/registry.ts';
import { mentionToken, methodArgs, methodsOf, placeholderFor, type DraftMention, type MethodOffer } from '../logic/composer.ts';
import { clamp } from '../logic/format.ts';
import { agentName, fnLabel, humanize, localName } from '../logic/labels.ts';
import { STATUS_LINE, statusLine, type RunView } from '../logic/runs.ts';
import { agentOptions, budgetMeter, messageSuggestions, modelLabel, whoAnswers, type SuggestionItem } from '../logic/session.ts';
import { messageText, threadItems, type MentionPart } from '../logic/thread.ts';
import { sendDraft } from '../state/send.ts';
import type { BudgetAsk } from '../state/thread.ts';
import type { ControlVerb } from '../logic/controls.ts';
import type { ChatPanel } from '../url.ts';

const props = withDefaults(defineProps<{
  session: SessionId;
  compact: boolean;
  /** The thread's column is narrow (a phone, or a panel beside it): words give way to icons. */
  narrow?: boolean;
  /** The header carries the app's navigation button (the app's top bar is hidden). */
  nav?: boolean;
  flash?: MessageId | undefined;
}>(), { narrow: false, nav: false, flash: undefined });
const emit = defineEmits<{
  run: [id: RunId]; llm: [id: LlmInteractionId]; details: [turn: TurnId]; tree: [turn: TurnId]; resource: [uri: ResourceUri];
  panel: [panel: ChatPanel]; sessions: []; nav: []; newChat: []; message: [id: MessageId]; shortcuts: []; remove: [];
}>();

const { chat, toasts, session: auth, connection } = useStores();
const router = useRouter();
const thread = chat.thread(props.session);
const composer = chat.composer(props.session);
const suggest = chat.suggestions(props.session);
const voice = chat.voice();
const caps = chat.capabilities;
const touch = isTouch();

const scroller = ref<ScrollerHandle | null>(null);
const composerBox = ref<ComposerHandle | null>(null);
const now = useTicker(() => thread.running.value || voice?.state.value === 'recording' || thread.background.value.length > 0);
const note = ref('');
let noteTimer: ReturnType<typeof setTimeout> | undefined;

const me = computed(() => auth.user.value?.id);
const record = computed(() => thread.session.value);
const agent = computed(() => (record.value === undefined ? 'Agent' : agentName(record.value.agent)));
const items = computed(() => threadItems(thread.messages.value, me.value, now.value));

/** A participant's name: you, the agent, or someone. */
function nameOf(actor: string): string {
  if (actor === me.value) { return auth.user.value?.name ?? 'You'; }
  const role = record.value?.participants.find((p) => p.actor === actor)?.role;
  return role === 'agent' ? agent.value : 'Someone';
}

// ── runs and renderers ────────────────────────────────────────────────────────

function runsOfTurn(turn: TurnId): RunView[] {
  const listed = new Set(thread.messages.value.filter((m) => m.turn === turn).flatMap((m) => m.runs));
  return [...thread.runs.value.values()].filter((run) => run.turn === turn || listed.has(run.id)).map((run) => thread.shown(run));
}

const liveTurn = computed(() => (thread.running.value ? (thread.awaiting.value ?? thread.lastTurn.value) : undefined));
const liveLine = computed(() => (liveTurn.value === undefined ? undefined : statusLine(runsOfTurn(liveTurn.value), now.value, STATUS_LINE, record.value?.agent)));
const hasAnswer = computed(() => liveTurn.value !== undefined && thread.messages.value.some((m) => m.turn === liveTurn.value && m.role === 'assistant'));

/** A run's renderer, with the session state fields its fn declared (the first draw loads them). */
function viewOf(run: RunView): RenderView<'fn'> | undefined {
  return chat.renderers.fnView(run, thread.stateOf(run.id));
}

/** How a fn's finished runs look in the thread, as its system declared. */
function displayOf(run: RunView): Display {
  return caps.value.value?.display[run.fn] ?? 'card';
}

function attachmentView(part: Extract<MessagePart, { type: 'attachment' }>): RenderView<'attachment'> | undefined {
  return chat.renderers.attachmentView(part);
}

provide(GIN_INPUTS, (type) => chat.renderers.inputView(type));

/** A budget raise is being saved. */
const raisingBudget = ref(false);
async function raiseBudget(ask: BudgetAsk, by: number): Promise<void> {
  raisingBudget.value = true;
  const raised = await thread.raiseBudget(ask, by);
  raisingBudget.value = false;
  if (raised) { toasts.ok('Budget raised. The run goes on.'); } else { toasts.error("Couldn't raise the budget", thread.problem.value); }
}

// ── messages ──────────────────────────────────────────────────────────────────

const lastAnswerTurn = computed(() => [...thread.messages.value].reverse().find((m) => m.role === 'assistant')?.turn);
const commandName = (context: QualifiedName): string => caps.commandFor(context)?.name ?? localName(context);

function userActions(mine: boolean): MessageAction[] {
  return ['copy', 'reply', ...(mine ? ['edit' as const] : []), 'link'];
}

function answerActions(turn: TurnId): MessageAction[] {
  const last = turn === lastAnswerTurn.value;
  return ['copy', 'reply', ...(last && !thread.running.value ? ['retry' as const] : []), ...(turn === thread.lastTurn.value && thread.canUndo.value ? ['undo' as const] : []), 'details', 'tree', 'link'];
}

function quoteOf(message: ChatMessage): { author: string; excerpt: string } | undefined {
  if (message.replyTo === undefined) { return undefined; }
  const original = thread.messages.value.find((m) => m.id === message.replyTo);
  return { author: original === undefined ? 'Earlier message' : nameOf(original.author), excerpt: original === undefined ? '' : clamp(messageText(original.parts), 80) };
}

async function act(action: MessageAction, messages: readonly ChatMessage[]): Promise<void> {
  const first = messages[0];
  if (first === undefined) { return; }
  switch (action) {
    case 'copy': {
      const ok = await copyText(messages.map((m) => messageText(m.parts)).join('\n\n'));
      if (!ok) { toasts.error("Couldn't copy"); }
      return;
    }
    case 'link': {
      const ok = await copyText(`${window.location.origin}/chat/${props.session}#m-${first.id}`);
      if (!ok) { toasts.error("Couldn't copy the link"); }
      return;
    }
    case 'reply': composer.setReply(first.id); composerBox.value?.focus(); return;
    case 'edit': {
      const mentions = first.parts.filter((p): p is MentionPart => p.type === 'mention').map((p): DraftMention => ({ type: 'mention', provider: p.provider, label: p.label, target: p.target }));
      composer.startEdit(first.id, messageText(first.parts), mentions);
      return;
    }
    case 'retry': if (!(await thread.retry(first.turn))) { toasts.error("Couldn't retry", thread.problem.value); } return;
    case 'undo': await undo(first.turn); return;
    case 'details': emit('details', first.turn); return;
    case 'tree': emit('tree', first.turn); return;
  }
}

async function undo(turn: TurnId): Promise<void> {
  const report = await thread.undoTurn(turn);
  if (report === undefined) { toasts.error("Couldn't undo", thread.problem.value); return; }
  const undone = report.undone.length;
  const left = report.failed.length + report.notUndoable.length;
  toasts.push({
    tone: left > 0 ? 'warn' : 'ok', title: undone > 0 ? `Undid ${undone} change${undone === 1 ? '' : 's'}` : 'Turn undone',
    ...(left > 0 ? { body: `${left} couldn't be undone.` } : {}),
    action: { label: 'Show note', run: () => { scroller.value?.toBottom(true); } },
  });
}

function quote(message: ChatMessage): void {
  if (message.replyTo !== undefined) { emit('message', message.replyTo); }
}

// ── mention cards ─────────────────────────────────────────────────────────────

const hovered = shallowRef<MentionPart | undefined>(undefined);
const hoverAnchor = ref<HTMLElement | null>(null);
const hoverOpen = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
const card = computed(() => (hovered.value === undefined ? undefined : chat.mentions.card(hovered.value.provider, hovered.value.target)));
const customCard = computed(() => (hovered.value === undefined ? undefined : chat.renderers.mentionView(hovered.value, card.value?.hover)));

/** The methods the hovered thing's type offers people. */
const hoverMethods = computed(() => {
  const provider = hovered.value?.provider;
  const of = caps.value.value?.mentions.find((m) => m.provider === provider)?.of;
  return methodsOf(caps.value.value?.methods ?? [], of);
});

/** Run a type method on the hovered thing: at once when it takes nothing else, else through its form. */
async function runMethod(method: MethodOffer): Promise<void> {
  const self = card.value?.hover?.value;
  if (self === undefined) { return; }
  hoverOpen.value = false;
  if (method.own !== undefined) {
    composer.openInvocation({ fn: method.fn, description: method.description, args: method.own }, self);
    return;
  }
  const run = await thread.invoke(method.fn, methodArgs({}, self));
  if (run === undefined) { toasts.error(`Couldn't ${method.label.toLowerCase()}`, thread.problem.value); return; }
  scroller.value?.toBottom();
}

function showCard(part: MentionPart, anchor: HTMLElement): void {
  clearTimeout(hoverTimer);
  hovered.value = part;
  hoverAnchor.value = anchor;
  hoverOpen.value = true;
  void chat.mentions.load(props.session, part.provider, part.target);
}
function keepCard(): void {
  clearTimeout(hoverTimer);
}
function hideCard(): void {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoverOpen.value = false; }, 300);
}

function openLink(link: Link): void {
  hoverOpen.value = false;
  if ('resource' in link) { emit('resource', link.resource); return; }
  if ('run' in link) { emit('run', link.run); return; }
  if ('url' in link) { window.open(link.url, '_blank', 'noopener,noreferrer'); return; }
  toasts.push({ title: link.title, body: "Files can't be opened from the chat yet." });
}

/** A link inside an answer: a path in this app goes there; a resource URI opens the viewer. */
function navigate(href: string): void {
  if (href.startsWith('/')) { void router.push(href); return; }
  const resource = ResourceUri.safeParse(href);
  if (resource.success && !/^https?:/.test(href)) { emit('resource', resource.data); }
}

// ── suggestions and starters ──────────────────────────────────────────────────

function useSuggestion(item: SuggestionItem, kind: 'context' | 'fn'): void {
  if (kind === 'fn') {
    const invocation = caps.invocation(item.name);
    if (invocation === undefined) { toasts.push({ title: `${item.label} can't be run by hand` }); return; }
    composer.openInvocation(invocation);
    return;
  }
  const command = caps.commandFor(item.name);
  if (command === undefined) { toasts.push({ title: `${item.label} has no command to add it` }); return; }
  composer.replace(`/${command.name} ${composer.text.value}`);
}

/** The fixed starters. The hub offers no questions of its own for a context yet, so its descriptions aren't used as starters. */
const starters: readonly Starter[] = [
  { key: 'g:plan', title: 'Plan a change with me', text: 'Help me plan a change. Ask me what you need to know first.', icon: 'sparkles' },
  { key: 'g:explain', title: 'Explain how something works', text: 'Explain how this works: ', icon: 'info' },
  { key: 'g:find', title: 'Find something in my files', text: 'Find where ', icon: 'search' },
  { key: 'g:fns', title: 'What can you do here?', text: 'What can you do in this chat? List the fns and context you can use.', icon: 'fn' },
];

async function start(starter: Starter): Promise<void> {
  if (starter.text.endsWith(' ')) { composer.replace(starter.text); return; }
  composer.replace(starter.text);
  await send();
}

// ── composer ──────────────────────────────────────────────────────────────────

const picker = computed(() => ({
  open: composer.pickerOpen.value, kind: composer.trigger.value?.kind, items: composer.pickerItems.value, active: composer.pickerActive.value, loading: composer.pickerLoading.value,
}));
const replyView = computed(() => {
  const id = composer.replyTo.value;
  const original = id === undefined ? undefined : thread.messages.value.find((m) => m.id === id);
  return original === undefined ? undefined : { author: nameOf(original.author), excerpt: clamp(messageText(original.parts), 90) };
});
const replyMessage = computed(() => thread.messages.value.find((m) => m.id === composer.replyTo.value));
// said under the box only when it isn't the usual answer (the session's agent, which the bar under it shows already)
const answerers = computed(() => { if (record.value === undefined) { return ''; } const who = whoAnswers(record.value, replyMessage.value, composer.replyAll.value); return who.usual ? '' : who.text; });
const replyAllShown = computed(() => (record.value?.participants.filter((p) => p.role === 'agent').length ?? 0) > 1 || (record.value?.participants.filter((p) => p.role !== 'agent').length ?? 0) > 1);
/** The engine the hub's dictation role picked (the model, unless it says the browser). */
const dictation = computed(() => caps.value.value?.dictation ?? { engine: 'model' as const });
const voiceView = computed(() => ({ available: voice !== undefined && caps.can.value.voice && voice.can(dictation.value.engine), state: voice?.state.value ?? 'idle', startedAt: voice?.startedAt.value ?? 0, problem: voice?.problem.value ?? '' }));
const tokens = computed(() => composer.mentions.value.map(mentionToken));

function flashNote(text: string): void {
  note.value = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { note.value = ''; }, 4_000);
}

/** An edit waiting for the person to confirm what it undoes. */
const confirmingEdit = ref(false);
const editTurns = computed(() => (composer.editing.value === undefined ? 0 : thread.turnsFrom(composer.editing.value).length));

async function send(confirmed = false): Promise<void> {
  if (!confirmed && editTurns.value > 0) { confirmingEdit.value = true; return; }
  confirmingEdit.value = false;
  scroller.value?.toBottom();
  const result = await sendDraft(thread, composer, suggest);
  if (!result.ok) {
    if (result.problem !== '') { toasts.error("Couldn't send", result.problem); }
    return;
  }
  const { moved, undone } = result.value;
  if (moved > 0) { flashNote(`${moved} run${moved === 1 ? '' : 's'} moved to the background`); }
  if (undone !== undefined) { flashNote(`Undid ${undone.undone} change${undone.undone === 1 ? '' : 's'} and sent your edit`); }
  scroller.value?.toBottom();
}

function onInput(text: string, caret: number): void {
  composer.input(text, caret);
  suggest.update(text);
  thread.reportPresence({ typing: text !== '' });
}

function recall(): void {
  const mine = [...thread.messages.value].reverse().find((m) => m.role === 'user' && m.author === me.value);
  if (mine !== undefined) { void act('edit', [mine]); }
}

async function control(verb: ControlVerb, runs: readonly RunId[] | undefined): Promise<void> {
  if (!(await thread.control(verb, runs))) { toasts.error(verb === 'resume' ? "Couldn't resume" : "Couldn't stop", thread.problem.value); }
}

async function invoke(args: Json): Promise<void> {
  const invocation = composer.invoking.value;
  if (invocation === undefined) { return; }
  const run = await thread.invoke(invocation.fn, composer.invocationArgs(args));
  if (run === undefined) { toasts.error(`Couldn't run ${fnLabel(invocation.fn)}`, thread.problem.value); return; }
  composer.closeInvocation();
  scroller.value?.toBottom();
}

async function startVoice(): Promise<void> {
  await voice?.start(dictation.value.engine, dictation.value.language);
}
async function stopVoice(): Promise<void> {
  const text = await voice?.stop();
  if (text !== undefined && text !== '') { composer.insert(text); }
}

function useDraftSuggestion(item: { kind: 'fn' | 'context'; name: QualifiedName }): void {
  useSuggestion({ name: item.name, label: item.kind === 'fn' ? fnLabel(item.name) : humanize(localName(item.name)), system: splitName(item.name).system, why: '', state: 'offered', score: undefined }, item.kind);
}

// ── approvals, questions and the header ───────────────────────────────────────

const approvals = computed<ApprovalView[]>(() => thread.approvals.value.map((a) => ({
  id: a.id, fn: a.fn, description: caps.invocation(a.fn)?.description ?? '', args: thread.runs.value.get(a.run)?.args,
})));
watch(() => thread.approvals.value.map((a) => a.run), (runs) => { for (const run of runs) { void thread.ensureRun(run); } }, { immediate: true });

async function decide(id: Parameters<typeof thread.approve>[0], approve: boolean, remember: Parameters<typeof thread.approve>[2], reason: string): Promise<void> {
  if (!(await thread.approve(id, approve, remember, reason))) { toasts.error("Couldn't send your answer", thread.problem.value); }
}

const people = computed(() => (record.value?.participants ?? []).map((p) => ({ name: nameOf(p.actor), agent: p.role === 'agent' })));
const waiting = computed(() => thread.approvals.value.length + thread.handlers.value.length);
const systems = computed(() => {
  const all = caps.value.value?.systems ?? [];
  const used = record.value?.systems === 'all' || record.value === undefined ? all : all.filter((s) => record.value?.systems.includes(s.name) === true);
  return { total: used.length, offline: used.filter((s) => s.status !== 'connected').length };
});
const turnSpent = computed(() => (liveTurn.value === undefined ? 0 : runsOfTurn(liveTurn.value).reduce((sum, run) => sum + run.cost, 0)));
const meter = computed(() => budgetMeter(thread.limits.value, thread.spent.value, thread.spentSince.value, turnSpent.value));

function header(action: HeaderAction): void {
  switch (action) {
    case 'tree': if (thread.lastTurn.value !== undefined) { emit('tree', thread.lastTurn.value); } return;
    case 'undo': if (thread.lastTurn.value !== undefined) { void undo(thread.lastTurn.value); } return;
    case 'settings': emit('panel', 'settings'); return;
    case 'people': emit('panel', 'people'); return;
    case 'shortcuts': emit('shortcuts'); return;
    case 'archive': void archive(); return;
    case 'delete': emit('remove'); return;
    case 'rename': return;
  }
}

/** The agents the meta row's menu offers, the current one first. */
const agents = computed(() => agentOptions(caps.value.value?.agents ?? [], record.value?.agent));

async function switchAgent(fn: QualifiedName): Promise<void> {
  if (await thread.update({ agent: fn })) { toasts.ok(`${agentName(fn)} answers from now on`); } else { toasts.error("Couldn't switch agents", thread.problem.value); }
}

async function rename(title: string): Promise<void> {
  if (!(await thread.update({ title }))) { toasts.error("Couldn't rename", thread.problem.value); }
}

async function archive(): Promise<void> {
  const archived = !(record.value?.archived ?? false);
  if (await thread.update({ archived })) { toasts.ok(archived ? 'Archived' : 'Restored'); } else { toasts.error("Couldn't change that", thread.problem.value); }
}

const failedReason = computed(() => {
  const last = [...thread.messages.value].reverse().find((m) => m.role === 'assistant');
  return last?.status === 'failed' ? messageText(last.parts) : '';
});

function retryLast(): void {
  const turn = lastAnswerTurn.value;
  if (turn !== undefined) { void act('retry', thread.messages.value.filter((m) => m.turn === turn && m.role === 'assistant')); }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

const dropping = ref(false);
function onDrop(event: DragEvent): void {
  dropping.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0 && caps.can.value.upload) { composer.uploads.add(files); }
}

watch(() => [props.flash, thread.status.value] as const, ([id, status]) => {
  if (id === undefined || status !== 'ready') { return; }
  requestAnimationFrame(() => {
    if (scroller.value?.reveal(`m-${id}`) === false && thread.hasOlder.value) { void thread.loadOlder(); }
  });
}, { immediate: true });

onMounted(() => {
  void chat.open(props.session).then(() => {
    if (props.flash === undefined) { scroller.value?.toBottom(); }
  });
});
onBeforeUnmount(() => {
  clearTimeout(noteTimer);
  clearTimeout(hoverTimer);
});

defineExpose({ focusComposer: () => { composerBox.value?.focus(); } });
</script>

<template>
  <div class="pane" :class="{ dropping }" data-testid="thread-pane" @dragover.prevent="dropping = caps.can.value.upload" @dragleave.self="dropping = false" @drop.prevent="onDrop">
    <ChatHeader
      :title="record?.title ?? ''" :status="record?.status" :people="people" :compact="compact" :can-undo="thread.canUndo.value" :has-turn="thread.lastTurn.value !== undefined"
      :archived="record?.archived ?? false" :waiting="waiting" :nav="nav" :stale="thread.stale.value" @sessions="emit('sessions')" @nav="emit('nav')" @rename="rename" @action="header"
    />

    <div v-if="thread.status.value === 'loading' && thread.messages.value.length === 0" class="loading" data-testid="thread-loading" aria-busy="true">
      <div v-for="n in 4" :key="n" class="ghost" :class="{ right: n % 2 === 1 }"><UiSkeleton shape="lines" :lines="n % 2 === 1 ? 1 : 3" /></div>
    </div>
    <UiEmpty v-else-if="thread.status.value === 'error'" class="error" icon="warning" tone="danger" title="This chat didn't open" :body="thread.problem.value" data-testid="thread-error">
      <template #actions><UiButton variant="primary" icon="refresh" @click="thread.open()">Try again</UiButton></template>
    </UiEmpty>
    <ChatScroller
      v-else ref="scroller" class="thread" :items="items" :has-older="thread.hasOlder.value" :loading-older="thread.loadingOlder.value" :beginning="thread.beginning.value"
      :needs-you="waiting > 0" @older="thread.loadOlder()"
    >
      <template #empty>
        <Starters :starters="starters" :agent="agent" @pick="start" />
      </template>
      <template #item="{ item }">
        <div v-if="item.kind === 'day'" class="day" role="separator" data-testid="day-separator"><span>{{ item.label }}</span></div>
        <UserMessage
          v-else-if="item.kind === 'user'" :message="item.message" :mine="item.mine" :author-name="nameOf(item.message.author)" :now="now" :command-name="commandName"
          :suggestions="messageSuggestions(item.message, record)" :actions="userActions(item.mine)" :quote="quoteOf(item.message)" :flash="flash === item.message.id"
          :runs="thread.runsOf(item.message)" :view-of="viewOf" :collapsed="(run: RunView) => chat.collapse.isCollapsed(run)" :carried="item.carried" :attachment-view="attachmentView"
          @action="act($event, [item.message])" @quote="quote(item.message)" @mention-hover="showCard" @mention-leave="hideCard" @mention-open="showCard"
          @suggestion="useSuggestion" @run="emit('run', $event)" @run-toggle="(id, collapsed) => chat.collapse.set(id, collapsed)" @background="thread.toBackground($event)" @link="openLink"
        />
        <AssistantAnswer
          v-else-if="item.kind === 'answer'" :messages="item.messages" :author-name="nameOf(item.author)" :now="now" :streaming="item.streaming" :failed="item.failed"
          :runs-of="(m: ChatMessage) => thread.runsOf(m)" :marks="thread.marks.value" :reasoning-of="(m: ChatMessage) => thread.reasoningOf(m)" :collapsed="(run: RunView) => chat.collapse.isCollapsed(run)"
          :view-of="viewOf" :display-of="displayOf" :attachment-view="attachmentView" :actions="answerActions(item.turn)" :flash="item.messages.some((m) => m.id === flash)"
          :status-line="item.turn === liveTurn ? liveLine : undefined" :navigate="navigate"
          @action="act($event, item.messages)" @run-open="emit('run', $event)" @run-toggle="(id, collapsed) => chat.collapse.set(id, collapsed)"
          @collapse-all="(collapsed) => chat.collapse.setAll(item.messages.flatMap((m) => m.runs), collapsed)" @background="thread.toBackground($event)"
          @tree="emit('tree', item.turn)" @link="openLink"
        />
        <NoteRow v-else :message="item.message" :undone="item.undone" :flash="flash === item.message.id" />
      </template>
      <template #foot>
        <PendingMessage v-if="thread.pending.value" :parts="thread.pending.value.parts" :command-name="commandName" :queued="connection.state.value === 'offline'" />
        <PendingAnswer v-if="liveTurn !== undefined && !hasAnswer && liveLine" :author-name="agent" :line="liveLine" @tree="liveTurn && emit('tree', liveTurn)" />
        <TurnNotice v-if="thread.failures.value > 0 && !thread.running.value" :reason="failedReason" :failures="thread.failures.value" @retry="retryLast" @fresh="emit('newChat')" />
        <p v-if="thread.typing.value.length > 0" class="typing-others" data-testid="others-typing">{{ thread.typing.value.length === 1 ? `${nameOf(thread.typing.value[0]?.user ?? '')} is typing…` : 'Several people are typing…' }}</p>
      </template>
    </ChatScroller>

    <div class="dock">
      <div class="dock-inner">
        <BackgroundStrip :runs="thread.background.value" :now="now" @open="emit('run', $event)" />
        <ApprovalTray :items="approvals" @decide="decide" @decide-all="(approve, remember) => thread.approveAll(approve, remember)" />
        <BudgetCard
          v-for="ask in thread.budgets.value" :key="ask.budget.id" :ask="ask" :fn-label="fnLabel(thread.runs.value.get(ask.run)?.fn ?? 'hub/run')"
          :can-raise="auth.user.value?.role === 'admin'" :busy="raisingBudget" @raise="raiseBudget(ask, $event)" @leave="thread.leaveBudget(ask)"
        />
        <HandlerCard
          v-for="call in thread.handlers.value" :key="call.id" :call="call" :fn-label="fnLabel(thread.runs.value.get(call.run)?.fn ?? 'hub/run')"
          @answer="thread.answer(call.id, $event)"
        />
        <InvocationForm v-if="composer.invoking.value" :invocation="composer.invoking.value" :busy="false" @submit="invoke" @cancel="composer.closeInvocation()" />
        <DraftSuggestions :items="suggest.items.value" @use="useDraftSuggestion" />
        <Composer
          ref="composerBox" :text="composer.text.value" :caret-request="composer.caretRequest.value" :placeholder="placeholderFor(caps.value.value, compact || narrow)"
          :tokens="tokens" :can-send="composer.canSend.value" :sending="thread.sending.value" :running="thread.running.value" :paused="thread.paused.value"
          :stopping="thread.stopping.value" :controls="thread.controls.value" :picker="picker" :hint="composer.hint.value" :files="composer.uploads.items.value"
          :reply="replyView" :editing="composer.editing.value !== undefined" :reply-all="{ shown: replyAllShown, on: composer.replyAll.value }" :answerers="answerers"
          :can-attach="caps.can.value.upload" :voice="voiceView" :now="now" :touch="touch" :note="note"
          @input="onInput" @caret="composer.moveCaret($event)" @send="send()" @control="control"
          @picker-move="composer.movePicker($event)" @picker-hover="composer.pickerActive.value = $event" @pick="composer.pick($event)" @picker-dismiss="composer.dismissPicker()"
          @attach="composer.uploads.add($event)" @remove-file="composer.uploads.remove($event)" @retry-file="composer.uploads.retry($event)"
          @clear-reply="composer.setReply(undefined)" @cancel-edit="composer.cancelEdit()" @reply-all="composer.replyAll.value = $event"
          @voice-start="startVoice" @voice-stop="stopVoice" @voice-cancel="voice?.cancel()" @voice-dismiss="voice?.dismiss()" @recall="recall"
          @focus="(focused) => thread.reportPresence({ typing: focused && composer.text.value !== '' })"
        />
        <ComposerMeta
          :agent="agent" :agents="agents" :model="modelLabel(record?.model, caps.value.value?.models ?? [])" :systems="systems" :background="thread.background.value.length" :spent="thread.spent.value" :meter="meter" :compact="compact || narrow"
          @settings="emit('panel', 'settings')" @model="emit('panel', 'model')" @agent="switchAgent" @background="thread.background.value[0] && emit('run', thread.background.value[0].id)"
        />
      </div>
    </div>

    <ConfirmDialog
      v-model:open="confirmingEdit" title="Send your edit?" confirm="Undo and send" :danger="false" data-testid="confirm-edit"
      :body="`This undoes ${editTurns === 1 ? 'the turn' : `${editTurns} turns`} from that message on, then sends your edit. Changes a fn made can't always be undone; the note after says what stayed.`"
      @confirm="send(true)"
    />

    <UiPopover v-model:open="hoverOpen" :anchor="hoverAnchor" side="top" align="start" label="Mention" :take-focus="false">
      <div @mouseenter="keepCard" @mouseleave="hideCard">
        <HoverCard
          v-if="hovered && card" :label="hovered.label" :hover="card.hover" :loading="card.loading" :problem="card.problem" :custom="customCard"
          :methods="hoverMethods" @open="card.hover?.open && openLink(card.hover.open)" @method="runMethod"
        />
      </div>
    </UiPopover>
  </div>
</template>

<style scoped>
/* a size container, so the composer's height can follow the thread's (cqh) */
.pane { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; min-width: 0; min-height: 0; container: thread / size; }
.pane.dropping::after {
  content: 'Drop files to attach'; position: absolute; inset: var(--space-3); display: grid; place-items: center; border: 2px dashed var(--accent);
  border-radius: var(--radius-xl); background: color-mix(in oklch, var(--accent-soft) 70%, transparent); color: var(--accent); font-weight: var(--weight-strong);
  pointer-events: none; z-index: var(--z-sticky);
}
.thread { min-height: 0; }
.loading { display: grid; align-content: end; gap: var(--space-5); width: 100%; max-width: calc(var(--readable) + 120px); margin: 0 auto; padding: var(--space-5); overflow: hidden; }
.ghost { width: min(70%, 520px); }
.ghost.right { justify-self: end; width: min(45%, 320px); }
.error { align-self: center; }
.day { display: flex; align-items: center; gap: var(--space-3); color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.day::before, .day::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.typing-others { margin: 0; padding: 0 var(--space-2); color: var(--text-faint); font-size: var(--text-sm); font-style: italic; }
.dock { padding: 0 var(--space-5) max(var(--space-3), var(--safe-bottom)); background: linear-gradient(to bottom, transparent, var(--bg) var(--space-3)); }
.dock-inner { display: grid; gap: var(--space-2); width: 100%; max-width: calc(var(--readable) + 120px - 2 * var(--space-5)); margin: 0 auto; }
@media (max-width: 759.98px) { .dock { padding: 0 var(--space-2) max(var(--space-2), var(--safe-bottom)); } .loading { padding: var(--space-3); } }
</style>
