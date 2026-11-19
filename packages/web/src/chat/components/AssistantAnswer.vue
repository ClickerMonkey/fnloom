<script setup lang="ts">
/**
 * One agent's answer to one turn as one bubble with one avatar and one time, its pieces in exactly the order the model
 * produced them (`answerPieces`): reasoning, words and the fns it ran (as cards, in call order; a stretch of calls, with the reasoning between
 * them, collapses into one section, `RunGroup`, when grouping is on), with what the fns
 * attached after them. Each stretch of reasoning sits collapsed where it happened (reasoning next to reasoning, with no
 * call that shows, words or card between, is one block: `mergeReasoning`), shimmering while it streams. Text
 * renders as markdown as it arrives, with one soft caret while streaming. Attachments draw through their system's renderer, links as cards. While the turn is in flight the status line sits at the foot of the
 * bubble; before anything arrives, a typing indicator stands in its place, and the message actions wait until there is
 * something to act on. A turn that hit a system held for review gets a banner per such system (`heldSystems`), linking
 * to its review for someone who can review.
 */
import type { ChatMessage, Display, Link, MessagePart, RunId } from '@harness/core';
import { computed, ref } from 'vue';
import { UiAvatar, UiMarkdown, fullTime, relativeTime } from '../../ui/index.ts';
import { groupPieces, mergeReasoning, type GroupedPiece } from '../logic/groups.ts';
import { heldSystems } from '../logic/held.ts';
import { lineHasNews, runResult, runShows, type RunView, type StatusLine as Line } from '../logic/runs.ts';
import { showsRows } from '../../components/widgets/widgets.ts';
import { answerPieces, type AnswerPiece, type AnswerSegment } from '../logic/thread.ts';
import AttachmentCard from './AttachmentCard.vue';
import HeldBanner from './HeldBanner.vue';
import LinkCard from './LinkCard.vue';
import MessageActions from './MessageActions.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import RunGroup from './RunGroup.vue';
import RunList from './RunList.vue';
import StatusLine from './StatusLine.vue';
import TypingDots from './TypingDots.vue';
import type { GroupStep, MessageAction, RenderView } from './types.ts';

type Attachment = Extract<MessagePart, { type: 'attachment' }>;

const props = withDefaults(defineProps<{
  messages: readonly ChatMessage[];
  authorName: string;
  now: number;
  streaming: boolean;
  failed: boolean;
  runsOf: (message: ChatMessage) => readonly RunView[];
  /** A message's segments in the order they streamed, when the thread saw it stream. */
  liveOf?: (message: ChatMessage) => readonly AnswerSegment[] | undefined;
  collapsed: (run: RunView) => boolean;
  viewOf: (run: RunView) => RenderView<'fn'> | undefined;
  /** How a fn's finished runs look: their card, a line of text, or nothing. */
  displayOf?: (run: RunView) => Display;
  attachmentView: (part: Attachment) => RenderView<'attachment'> | undefined;
  actions: readonly MessageAction[];
  /** The line under an answer in flight. */
  statusLine?: Line | undefined;
  /** Nothing has arrived yet: show the typing indicator. */
  waiting?: boolean;
  flash?: boolean;
  navigate?: ((href: string) => void) | undefined;
  /** Collapse fn calls in a row into one section (the chat's "Group fn calls" option). */
  grouped?: boolean;
  /** The person can review a system's pending changes (an admin): a held-system banner links to its review. */
  canReview?: boolean;
}>(), { grouped: true, canReview: false, displayOf: () => (): Display => 'card', liveOf: (): undefined => undefined, statusLine: undefined, waiting: false, flash: false, navigate: undefined });

const emit = defineEmits<{
  action: [action: MessageAction];
  runOpen: [run: RunId];
  runToggle: [run: RunId, collapsed: boolean];
  collapseAll: [collapsed: boolean];
  background: [run: RunId];
  tree: [];
  link: [link: Link];
}>();

/** Each message's pieces, reasoning next to reasoning (nothing shown between) merged into one block. */
const pieced = computed(() => new Map(props.messages.map((m) => [m.id, mergeReasoning(answerPieces(m, props.liveOf(m)), (piece) => shownIn(piece.runs).length)])));
const piecesOf = (message: ChatMessage): AnswerPiece[] => pieced.value.get(message.id) ?? [];
/** Reasoning still arriving: the last piece of a streaming message. */
const thinking = (message: ChatMessage, piece: AnswerPiece): boolean => message.status === 'streaming' && piecesOf(message).at(-1)?.key === piece.key;
/** A message's runs by id, for its run pieces. */
const runsById = computed(() => new Map(props.messages.flatMap((m) => props.runsOf(m)).map((run) => [run.id, run])));
/** The systems this turn found held for review, one banner each. */
const held = computed(() => heldSystems([...runsById.value.values()]));
const runsIn = (ids: readonly RunId[]): RunView[] => ids.flatMap((id) => { const run = runsById.value.get(id); return run === undefined ? [] : [run]; });
/** How each run shows now, by its fn's display once it is done. */
const showOf = (run: RunView): Display => runShows(run, props.displayOf(run));
/** The runs of a piece that show at all. */
const shownIn = (ids: readonly RunId[]): RunView[] => runsIn(ids).filter((run) => showOf(run) !== 'hidden');
/** Each message's pieces with its stretches of fn calls folded into groups (when grouping is on). */
const groupedPieces = computed(() => new Map(props.messages.map((m) => [m.id, groupPieces(piecesOf(m), props.grouped, (piece) => shownIn(piece.runs).length, (piece) => shownIn(piece.runs).some((run) => showsRows(runResult(run))))])));
const groupedOf = (message: ChatMessage): GroupedPiece[] => groupedPieces.value.get(message.id) ?? [];
/** A piece's key within the answer (its message and place), which open states and the caret go by. */
const keyOf = (message: ChatMessage, piece: { readonly key: string }): string => `${message.id}-${piece.key}`;
/** A group's steps with their runs, the calls that don't show left out. */
const stepsOf = (piece: Extract<GroupedPiece, { kind: 'group' }>): GroupStep[] => piece.steps.flatMap((step): GroupStep[] => {
  if (step.kind === 'reasoning') { return [step]; }
  const runs = shownIn(step.runs);
  return runs.length === 0 ? [] : [{ kind: 'runs', key: step.key, runs }];
});
/** The last text piece of the last message, where the streaming caret sits. */
const caretKey = computed(() => {
  const last = props.messages.at(-1);
  return last?.status === 'streaming' ? `${last.id}-${piecesOf(last).findLast((p) => p.kind === 'text')?.key ?? ''}` : '';
});
const first = computed(() => props.messages[0]);
/** Nothing of the answer has arrived yet: no text, runs, attachments, links or reasoning. */
const empty = computed(() => props.messages.every((m) => piecesOf(m).length === 0));
/** The answer is on its way but has nothing to show: the typing indicator stands in, and there is nothing to act on. */
const pending = computed(() => empty.value && (props.streaming || props.waiting));
/** The run cards not folded into a group, which Collapse all and Expand all act on. */
const allRuns = computed(() => props.messages.flatMap((m) => groupedOf(m).flatMap((piece) => (piece.kind === 'runs' ? shownIn(piece.runs).filter((run) => showOf(run) === 'card') : []))));
const anyExpanded = computed(() => allRuns.value.some((run) => !props.collapsed(run)));
/** The reasoning pieces opened, by message and piece. */
const openReasoning = ref<ReadonlySet<string>>(new Set());

/** The run groups opened, by message and piece. */
const openGroups = ref<ReadonlySet<string>>(new Set());

function setGroup(id: string, open: boolean): void {
  const next = new Set(openGroups.value);
  if (open) { next.add(id); } else { next.delete(id); }
  openGroups.value = next;
}

function setReasoning(id: string, open: boolean): void {
  const next = new Set(openReasoning.value);
  if (open) { next.add(id); } else { next.delete(id); }
  openReasoning.value = next;
}

</script>

<template>
  <div v-if="first" :id="`m-${first.id}`" class="answer" :class="{ flash, failed }" data-testid="assistant-answer" :data-turn="first.turn" tabindex="-1">
    <UiAvatar class="avatar" :name="authorName" kind="agent" :size="28" />
    <div class="column">
      <header class="head">
        <span class="author">{{ authorName }}</span>
        <!-- a message with no time (createdAt 0: a system page's conversation, components.Conversation) leaves it out -->
        <time v-if="first.createdAt > 0" class="time" :datetime="new Date(first.createdAt).toISOString()" :title="fullTime(first.createdAt)">{{ relativeTime(first.createdAt, now) }}</time>
        <button v-if="allRuns.length > 1" type="button" class="collapse-all" @click="emit('collapseAll', anyExpanded)">
          {{ anyExpanded ? 'Collapse all' : 'Expand all' }}
        </button>
      </header>
      <div class="body">
        <template v-for="message in messages" :key="message.id">
          <template v-for="piece in groupedOf(message)" :key="`${message.id}-${piece.key}`">
            <ReasoningBlock
              v-if="piece.kind === 'reasoning'" :text="piece.text" :thinking="thinking(message, piece)"
              :open="openReasoning.has(keyOf(message, piece))" @update:open="setReasoning(keyOf(message, piece), $event)"
            />
            <div v-else-if="piece.kind === 'text'" class="text" :class="{ caret: caretKey === keyOf(message, piece) }" data-testid="answer-text">
              <UiMarkdown :source="piece.text" :navigate="navigate" />
            </div>
            <RunGroup
              v-else-if="piece.kind === 'group'" :open="openGroups.has(keyOf(message, piece))" :steps="stepsOf(piece)" :now="now" :collapsed="collapsed"
              :view-of="viewOf" :show-of="showOf" @update:open="setGroup(keyOf(message, piece), $event)"
              @open="emit('runOpen', $event)" @toggle="(id, c) => emit('runToggle', id, c)" @background="emit('background', $event)"
            />
            <RunList
              v-else-if="piece.kind === 'runs' && shownIn(piece.runs).length > 0" :runs="shownIn(piece.runs)" :now="now" :collapsed="collapsed" :view-of="viewOf" :show-of="showOf"
              @open="emit('runOpen', $event)" @toggle="(id, c) => emit('runToggle', id, c)" @background="emit('background', $event)"
            />
            <AttachmentCard v-else-if="piece.kind === 'attachment'" :view-key="`${message.id}-${piece.key}`" :title="piece.part.title" :attachment="piece.part.attachment" :data="piece.part.data" :view="attachmentView(piece.part)" />
            <LinkCard v-else-if="piece.kind === 'link'" :link="piece.link" @open="emit('link', $event)" />
          </template>
        </template>
        <HeldBanner v-for="system in held" :key="system.system" :held="system" :can-review="canReview" />
        <StatusLine v-if="statusLine && lineHasNews(statusLine)" :line="statusLine" @tree="emit('tree')" />
        <TypingDots v-else-if="pending" :label="`${authorName} is working`" data-testid="answer-typing" />
      </div>
      <div v-if="!pending" class="meta">
        <MessageActions class="actions" :actions="actions" @action="emit('action', $event)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.answer { display: flex; gap: var(--space-3); min-width: 0; padding: var(--space-1) 0; border-radius: var(--radius-lg); animation: ui-rise-in var(--medium) var(--ease); }
.answer:focus { outline: none; }
.avatar { flex: none; margin-top: 2px; }
.column { display: grid; gap: var(--space-1); flex: 1; min-width: 0; }
.head { display: flex; align-items: baseline; gap: var(--space-2); min-height: 28px; }
.author { font-weight: var(--weight-medium); font-size: var(--text-sm); }
.time { color: var(--text-faint); font-size: var(--text-xs); }
.collapse-all { margin-left: auto; min-height: 28px; padding: 0 var(--space-1); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-faint); font-size: var(--text-xs); }
.collapse-all:hover { color: var(--text); }
.body { display: grid; gap: var(--space-3); min-width: 0; line-height: var(--leading); overflow-wrap: anywhere; }
.failed .body { color: var(--text-dim); }
.text { min-width: 0; }
.text :deep(table), .text :deep(pre) { max-width: 100%; overflow-x: auto; }
/* one caret, after the last block of the words (never also after the block's own last child) */
.caret :deep(.ui-markdown > :last-child)::after {
  content: ''; display: inline-block; width: 0.5em; height: 1.05em; margin-left: 2px; vertical-align: text-bottom;
  border-radius: 2px; background: var(--accent); animation: caret 1s steps(2) infinite;
}
@keyframes caret { 50% { opacity: 0; } }
.meta { display: flex; min-height: 32px; }
.actions { opacity: 0; transition: opacity var(--fast) var(--ease); }
.answer:hover .actions, .answer:focus-within .actions { opacity: 1; }
@media (hover: none) { .actions { opacity: 1; } }
.flash { animation: ui-flash 1.6s var(--ease); }
</style>
