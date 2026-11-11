<script setup lang="ts">
/**
 * One agent's answer to one turn as one bubble with one avatar and one time, its pieces in exactly the order the model
 * produced them (`answerPieces`): reasoning, words and the fns it ran (as cards, in call order; calls in a row collapse
 * into one section, `RunGroup`, when grouping is on), with what the fns
 * attached after them. Each stretch of reasoning sits collapsed where it happened, shimmering while it streams. Text
 * renders as markdown as it arrives, with one soft caret while streaming. Attachments draw through their system's renderer, links as cards. While the turn is in flight the status line sits at the foot of the
 * bubble; before anything arrives, a typing indicator stands in its place, and the message actions wait until there is
 * something to act on.
 */
import type { ChatMessage, Display, Link, MessagePart, RunId } from '@harness/core';
import { computed, ref } from 'vue';
import { UiAvatar, UiIcon, UiMarkdown, fullTime, relativeTime } from '../../ui/index.ts';
import { groups } from '../logic/groups.ts';
import { lineHasNews, runShows, type RunView, type StatusLine as Line } from '../logic/runs.ts';
import { answerPieces, type AnswerPiece, type AnswerSegment } from '../logic/thread.ts';
import AttachmentCard from './AttachmentCard.vue';
import LinkCard from './LinkCard.vue';
import MessageActions from './MessageActions.vue';
import RunGroup from './RunGroup.vue';
import RunList from './RunList.vue';
import StatusLine from './StatusLine.vue';
import TypingDots from './TypingDots.vue';
import type { MessageAction, RenderView } from './types.ts';

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
}>(), { grouped: true, displayOf: () => (): Display => 'card', liveOf: (): undefined => undefined, statusLine: undefined, waiting: false, flash: false, navigate: undefined });

const emit = defineEmits<{
  action: [action: MessageAction];
  runOpen: [run: RunId];
  runToggle: [run: RunId, collapsed: boolean];
  collapseAll: [collapsed: boolean];
  background: [run: RunId];
  tree: [];
  link: [link: Link];
}>();

const pieced = computed(() => new Map(props.messages.map((m) => [m.id, answerPieces(m, props.liveOf(m))])));
const piecesOf = (message: ChatMessage): AnswerPiece[] => pieced.value.get(message.id) ?? [];
/** Reasoning still arriving: the last piece of a streaming message. */
const thinking = (message: ChatMessage, piece: AnswerPiece): boolean => message.status === 'streaming' && piecesOf(message).at(-1)?.key === piece.key;
/** A message's runs by id, for its run pieces. */
const runsById = computed(() => new Map(props.messages.flatMap((m) => props.runsOf(m)).map((run) => [run.id, run])));
const runsIn = (ids: readonly RunId[]): RunView[] => ids.flatMap((id) => { const run = runsById.value.get(id); return run === undefined ? [] : [run]; });
/** How each run shows now, by its fn's display once it is done. */
const showOf = (run: RunView): Display => runShows(run, props.displayOf(run));
/** The runs of a piece that show at all. */
const shownIn = (ids: readonly RunId[]): RunView[] => runsIn(ids).filter((run) => showOf(run) !== 'hidden');
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
const allRuns = computed(() => props.messages.flatMap((m) => piecesOf(m).flatMap((piece) => {
  if (piece.kind !== 'runs') { return []; }
  const shown = shownIn(piece.runs);
  return groups(props.grouped, shown) ? [] : shown.filter((run) => showOf(run) === 'card');
})));
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

function toggleReasoning(id: string): void {
  const next = new Set(openReasoning.value);
  if (next.has(id)) { next.delete(id); } else { next.add(id); }
  openReasoning.value = next;
}

</script>

<template>
  <div v-if="first" :id="`m-${first.id}`" class="answer" :class="{ flash, failed }" data-testid="assistant-answer" :data-turn="first.turn" tabindex="-1">
    <UiAvatar class="avatar" :name="authorName" kind="agent" :size="28" />
    <div class="column">
      <header class="head">
        <span class="author">{{ authorName }}</span>
        <time class="time" :datetime="new Date(first.createdAt).toISOString()" :title="fullTime(first.createdAt)">{{ relativeTime(first.createdAt, now) }}</time>
        <button v-if="allRuns.length > 1" type="button" class="collapse-all" @click="emit('collapseAll', anyExpanded)">
          {{ anyExpanded ? 'Collapse all' : 'Expand all' }}
        </button>
      </header>
      <div class="body">
        <template v-for="message in messages" :key="message.id">
          <template v-for="piece in piecesOf(message)" :key="`${message.id}-${piece.key}`">
            <div v-if="piece.kind === 'reasoning'" class="reasoning" data-testid="reasoning">
              <button
                type="button" class="reasoning-toggle touch-target" :class="{ shimmer: thinking(message, piece) }"
                :aria-expanded="openReasoning.has(`${message.id}-${piece.key}`) ? 'true' : 'false'" @click="toggleReasoning(`${message.id}-${piece.key}`)"
              >
                <UiIcon :name="openReasoning.has(`${message.id}-${piece.key}`) ? 'chevron-down' : 'chevron-right'" :size="14" />
                {{ thinking(message, piece) ? 'Reasoning…' : 'Reasoning' }}
              </button>
              <p v-if="openReasoning.has(`${message.id}-${piece.key}`)" class="reasoning-text">{{ piece.text }}</p>
            </div>
            <div v-else-if="piece.kind === 'text'" class="text" :class="{ caret: caretKey === `${message.id}-${piece.key}` }" data-testid="answer-text">
              <UiMarkdown :source="piece.text" :navigate="navigate" />
            </div>
            <template v-else-if="piece.kind === 'runs' && shownIn(piece.runs).length > 0">
              <RunGroup
                v-if="groups(grouped, shownIn(piece.runs))" :open="openGroups.has(`${message.id}-${piece.key}`)" :runs="shownIn(piece.runs)" :now="now" :collapsed="collapsed"
                :view-of="viewOf" :show-of="showOf" @update:open="setGroup(`${message.id}-${piece.key}`, $event)"
                @open="emit('runOpen', $event)" @toggle="(id, c) => emit('runToggle', id, c)" @background="emit('background', $event)"
              />
              <RunList
                v-else :runs="shownIn(piece.runs)" :now="now" :collapsed="collapsed" :view-of="viewOf" :show-of="showOf"
                @open="emit('runOpen', $event)" @toggle="(id, c) => emit('runToggle', id, c)" @background="emit('background', $event)"
              />
            </template>
            <AttachmentCard v-else-if="piece.kind === 'attachment'" :view-key="`${message.id}-${piece.key}`" :title="piece.part.title" :attachment="piece.part.attachment" :data="piece.part.data" :view="attachmentView(piece.part)" />
            <LinkCard v-else-if="piece.kind === 'link'" :link="piece.link" @open="emit('link', $event)" />
          </template>
        </template>
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
.reasoning { display: grid; gap: var(--space-1); }
.reasoning-toggle { display: inline-flex; align-items: center; gap: 4px; justify-self: start; padding: 2px var(--space-1); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-faint); font-size: var(--text-sm); }
.reasoning-toggle:hover { color: var(--text-dim); background: var(--surface-2); }
.reasoning-text { margin: 0; padding: var(--space-2) var(--space-3); border-left: 2px solid var(--border-strong); color: var(--text-dim); font-size: var(--text-sm); white-space: pre-wrap; }
.shimmer {
  background: linear-gradient(90deg, var(--text-faint) 40%, var(--text) 50%, var(--text-faint) 60%) 0 0 / 300% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; animation: ui-shimmer 2s linear infinite;
}
.meta { display: flex; min-height: 32px; }
.actions { opacity: 0; transition: opacity var(--fast) var(--ease); }
.answer:hover .actions, .answer:focus-within .actions { opacity: 1; }
@media (hover: none) { .actions { opacity: 1; } }
.flash { animation: ui-flash 1.6s var(--ease); }
</style>
