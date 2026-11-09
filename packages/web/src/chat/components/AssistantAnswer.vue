<script setup lang="ts">
/**
 * One agent's answer to one turn as one bubble with one avatar and one time, its pieces in the order they happened
 * (`answerPieces`): the fns it ran as cards in call order, what they attached, and the reply. Reasoning sits collapsed
 * above, shimmering while it streams, and stays on the stored answer. Text renders as markdown as it arrives, with a
 * soft caret while streaming. Attachments draw through their system's renderer, links as cards. While the turn is in flight the status line sits at the foot of the
 * bubble; before anything arrives, a typing indicator stands in its place, and the message actions wait until there is
 * something to act on.
 */
import type { ChatMessage, Display, Link, MessageId, MessagePart, RunId } from '@harness/core';
import { computed, ref } from 'vue';
import { UiAvatar, UiIcon, UiMarkdown, fullTime, relativeTime } from '../../ui/index.ts';
import { lineHasNews, runMessage, runShows, type RunView, type StatusLine as Line } from '../logic/runs.ts';
import { answerPieces, type AnswerPiece } from '../logic/thread.ts';
import AttachmentCard from './AttachmentCard.vue';
import LinkCard from './LinkCard.vue';
import MessageActions from './MessageActions.vue';
import RunCard from './RunCard.vue';
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
  /** Where each run appeared in its streaming message's text. */
  marks?: ReadonlyMap<RunId, number>;
  reasoningOf: (message: ChatMessage) => string;
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
}>(), { displayOf: () => (): Display => 'card', marks: () => new Map(), statusLine: undefined, waiting: false, flash: false, navigate: undefined });

const emit = defineEmits<{
  action: [action: MessageAction];
  runOpen: [run: RunId];
  runToggle: [run: RunId, collapsed: boolean];
  collapseAll: [collapsed: boolean];
  background: [run: RunId];
  tree: [];
  link: [link: Link];
}>();

const pieced = computed(() => new Map(props.messages.map((m) => [m.id, answerPieces(m, props.marks)])));
const piecesOf = (message: ChatMessage): AnswerPiece[] => pieced.value.get(message.id) ?? [];
const hasText = (message: ChatMessage): boolean => piecesOf(message).some((piece) => piece.kind === 'text');
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
const empty = computed(() => props.messages.every((m) => piecesOf(m).length === 0 && props.reasoningOf(m) === ''));
/** The answer is on its way but has nothing to show: the typing indicator stands in, and there is nothing to act on. */
const pending = computed(() => empty.value && (props.streaming || props.waiting));
const allRuns = computed(() => props.messages.flatMap((m) => props.runsOf(m)).filter((run) => showOf(run) === 'card'));
const anyExpanded = computed(() => allRuns.value.some((run) => !props.collapsed(run)));
const openReasoning = ref<ReadonlySet<MessageId>>(new Set());

function toggleReasoning(id: MessageId): void {
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
          <div v-if="reasoningOf(message) !== ''" class="reasoning" data-testid="reasoning">
            <button type="button" class="reasoning-toggle touch-target" :class="{ shimmer: message.status === 'streaming' && !hasText(message) }" :aria-expanded="openReasoning.has(message.id) ? 'true' : 'false'" @click="toggleReasoning(message.id)">
              <UiIcon :name="openReasoning.has(message.id) ? 'chevron-down' : 'chevron-right'" :size="14" />
              {{ message.status === 'streaming' && !hasText(message) ? 'Reasoning…' : 'Reasoning' }}
            </button>
            <p v-if="openReasoning.has(message.id)" class="reasoning-text">{{ reasoningOf(message) }}</p>
          </div>
          <template v-for="piece in piecesOf(message)" :key="`${message.id}-${piece.key}`">
            <div v-if="piece.kind === 'text'" class="text" :class="{ caret: caretKey === `${message.id}-${piece.key}` }" data-testid="answer-text">
              <UiMarkdown :source="piece.text" :navigate="navigate" />
            </div>
            <div v-else-if="piece.kind === 'runs' && shownIn(piece.runs).length > 0" class="runs">
              <template v-for="run in shownIn(piece.runs)" :key="run.id">
                <button v-if="showOf(run) === 'message'" type="button" class="run-message" data-testid="run-message" :data-run="run.id" @click="emit('runOpen', run.id)">
                  <UiIcon name="fn" :size="14" />
                  <span class="run-message-text">{{ runMessage(run) }}</span>
                </button>
                <RunCard
                  v-else :run="run" :now="now" :collapsed="collapsed(run)" :view="viewOf(run)"
                  @open="emit('runOpen', run.id)" @toggle="emit('runToggle', run.id, $event)" @background="emit('background', run.id)"
                />
              </template>
            </div>
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
.caret :deep(> :last-child)::after, .caret :deep(> * > :last-child)::after {
  content: ''; display: inline-block; width: 0.5em; height: 1.05em; margin-left: 2px; vertical-align: text-bottom;
  border-radius: 2px; background: var(--accent); animation: caret 1s steps(2) infinite;
}
@keyframes caret { 50% { opacity: 0; } }
.runs { display: grid; gap: var(--space-2); min-width: 0; }
.run-message {
  display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; padding: var(--space-1) var(--space-2); border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-dim); font-size: var(--text-sm); line-height: var(--leading-tight); text-align: left;
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease);
}
.run-message:hover { background: var(--surface-2); color: var(--text); }
.run-message:focus-visible { outline: none; box-shadow: var(--ring); }
.run-message :deep(.ui-icon) { flex: none; margin-top: 1px; color: var(--text-faint); }
.run-message-text { min-width: 0; overflow-wrap: anywhere; }
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
