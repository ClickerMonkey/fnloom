<script setup lang="ts">
/**
 * One agent's answer to one turn: every iteration (text, then runs, then more text) as one bubble with one avatar
 * and one time. Reasoning sits collapsed above the text it led to, shimmering while it streams. Text renders as
 * markdown as it arrives, with a soft caret while streaming. Runs show as cards in call order, attachments through
 * their system's renderer, links as cards. While the turn is in flight the status line sits at the foot of the
 * bubble; before anything arrives, a typing indicator stands in its place.
 */
import type { ChatMessage, Link, MessageId, MessagePart, RunId } from '@harness/core';
import { computed, ref } from 'vue';
import { UiAvatar, UiIcon, UiMarkdown, fullTime, relativeTime } from '../../ui/index.ts';
import type { RunView, StatusLine as Line } from '../logic/runs.ts';
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
  reasoningOf: (message: MessageId) => string;
  collapsed: (run: RunId) => boolean;
  viewOf: (run: RunView) => RenderView | undefined;
  attachmentView: (part: Attachment) => RenderView | undefined;
  actions: readonly MessageAction[];
  /** The line under an answer in flight. */
  statusLine?: Line | undefined;
  /** Nothing has arrived yet: show the typing indicator. */
  waiting?: boolean;
  flash?: boolean;
  navigate?: ((href: string) => void) | undefined;
}>(), { statusLine: undefined, waiting: false, flash: false, navigate: undefined });

const emit = defineEmits<{
  action: [action: MessageAction];
  runOpen: [run: RunId];
  runToggle: [run: RunId, collapsed: boolean];
  collapseAll: [collapsed: boolean];
  background: [run: RunId];
  tree: [];
  link: [link: Link];
}>();

/** A message's pieces in order: text runs merged into one markdown block, then attachments and links as they came. */
type Piece = { kind: 'text'; key: string; text: string } | { kind: 'attachment'; key: string; part: Attachment } | { kind: 'link'; key: string; link: Link };

function pieces(message: ChatMessage): Piece[] {
  const out: Piece[] = [];
  message.parts.forEach((part, i) => {
    const last = out.at(-1);
    if (part.type === 'text') {
      if (last?.kind === 'text') { last.text += part.text; } else { out.push({ kind: 'text', key: `t${i}`, text: part.text }); }
    } else if (part.type === 'attachment') {
      out.push({ kind: 'attachment', key: `a${i}`, part });
    } else if (part.type === 'link') {
      out.push({ kind: 'link', key: `l${i}`, link: part.link });
    }
  });
  return out;
}

const pieced = computed(() => new Map(props.messages.map((m) => [m.id, pieces(m)])));
const piecesOf = (message: ChatMessage): Piece[] => pieced.value.get(message.id) ?? [];
const first = computed(() => props.messages[0]);
const allRuns = computed(() => props.messages.flatMap((m) => props.runsOf(m)));
const anyExpanded = computed(() => allRuns.value.some((run) => !props.collapsed(run.id)));
const openReasoning = ref<ReadonlySet<MessageId>>(new Set());

function toggleReasoning(id: MessageId): void {
  const next = new Set(openReasoning.value);
  if (next.has(id)) { next.delete(id); } else { next.add(id); }
  openReasoning.value = next;
}

const lastMessage = computed(() => props.messages.at(-1));
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
          <div v-if="reasoningOf(message.id) !== ''" class="reasoning" data-testid="reasoning">
            <button type="button" class="reasoning-toggle" :class="{ shimmer: message.status === 'streaming' && piecesOf(message).length === 0 }" :aria-expanded="openReasoning.has(message.id) ? 'true' : 'false'" @click="toggleReasoning(message.id)">
              <UiIcon :name="openReasoning.has(message.id) ? 'chevron-down' : 'chevron-right'" :size="14" />
              {{ message.status === 'streaming' && piecesOf(message).length === 0 ? 'Reasoning…' : 'Reasoning' }}
            </button>
            <p v-if="openReasoning.has(message.id)" class="reasoning-text">{{ reasoningOf(message.id) }}</p>
          </div>
          <template v-for="piece in piecesOf(message)" :key="`${message.id}-${piece.key}`">
            <div v-if="piece.kind === 'text'" class="text" :class="{ caret: message.status === 'streaming' && message === lastMessage }" data-testid="answer-text">
              <UiMarkdown :source="piece.text" :navigate="navigate" />
            </div>
            <AttachmentCard v-else-if="piece.kind === 'attachment'" :title="piece.part.title" :attachment="piece.part.attachment" :data="piece.part.data" :view="attachmentView(piece.part)" />
            <LinkCard v-else :link="piece.link" @open="emit('link', $event)" />
          </template>
          <div v-if="runsOf(message).length > 0" class="runs">
            <RunCard
              v-for="run in runsOf(message)" :key="run.id" :run="run" :now="now" :collapsed="collapsed(run.id)" :view="viewOf(run)"
              @open="emit('runOpen', run.id)" @toggle="emit('runToggle', run.id, $event)" @background="emit('background', run.id)"
            />
          </div>
        </template>
        <TypingDots v-if="waiting" label="The agent is writing" />
        <StatusLine v-if="statusLine && (streaming || waiting || statusLine.groups.length > 0)" :line="statusLine" @tree="emit('tree')" />
      </div>
      <div class="meta">
        <MessageActions class="actions" :actions="actions" @action="emit('action', $event)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.answer { display: flex; gap: var(--space-3); min-width: 0; padding: var(--space-1) 0; border-radius: var(--radius-lg); animation: ui-rise-in var(--medium) var(--ease); }
.answer:focus { outline: none; }
.avatar { flex: none; margin-top: 2px; }
.column { display: grid; gap: var(--space-1); flex: 1; min-width: 0; max-width: var(--readable); }
.head { display: flex; align-items: baseline; gap: var(--space-2); min-height: 28px; }
.author { font-weight: var(--weight-medium); font-size: var(--text-sm); }
.time { color: var(--text-faint); font-size: var(--text-xs); }
.collapse-all { margin-left: auto; padding: 0 var(--space-1); border: 0; background: transparent; color: var(--text-faint); font-size: var(--text-xs); }
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
