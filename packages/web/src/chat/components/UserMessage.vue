<script setup lang="ts">
/**
 * A person's message: on the right in the accent bubble when it is your own, on the left with the author's name and
 * avatar when it is someone else's. A reply shows a small quote that jumps to the original. A long message (a
 * pasted log) collapses after a few lines behind Show more. What the hub and hooks added for the model sits under it
 * behind a small icon in the meta row, beside the icons for what the index suggested (with counts, only when any). Runs the person started with `!` show
 * as live run cards under it. The action bar sits in the margin.
 */
import type { ChatMessage, Link, MessagePart, QualifiedName, RunId } from '@harness/core';
import { computed, onMounted, ref } from 'vue';
import { UiAvatar, UiIcon, fullTime, relativeTime } from '../../ui/index.ts';
import type { MessageSuggestions, SuggestionItem } from '../logic/session.ts';
import type { RunView } from '../logic/runs.ts';
import { splitParts, type MentionPart } from '../logic/thread.ts';
import AttachmentCard from './AttachmentCard.vue';
import LinkCard from './LinkCard.vue';
import MessageActions from './MessageActions.vue';
import PartList from './PartList.vue';
import RunCard from './RunCard.vue';
import SuggestionChips from './SuggestionChips.vue';
import type { MessageAction, RenderView } from './types.ts';

const props = withDefaults(defineProps<{
  message: ChatMessage;
  mine: boolean;
  authorName: string;
  now: number;
  commandName: (context: QualifiedName) => string;
  suggestions: MessageSuggestions;
  actions: readonly MessageAction[];
  /** The message this replies to. */
  quote?: { readonly author: string; readonly excerpt: string } | undefined;
  flash?: boolean;
  /** How many lines show before Show more. */
  clampLines?: number;
  /** The runs this message started (`!` invocations), as far as known. */
  runs?: readonly RunView[];
  /** A run's renderer and its props, when its system has one. */
  viewOf?: (run: RunView) => RenderView<'fn'> | undefined;
  /** Whether a run's card is collapsed. */
  collapsed?: (run: RunView) => boolean;
  /** The messages carrying what its runs attached (diffs, files, links), shown under its run cards. */
  carried?: readonly ChatMessage[];
  /** An attachment's renderer and its props, when its system has one. */
  attachmentView?: (part: Attachment) => RenderView<'attachment'> | undefined;
}>(), { quote: undefined, flash: false, clampLines: 8, runs: () => [], viewOf: () => undefined, collapsed: () => false, carried: () => [], attachmentView: () => undefined });

const emit = defineEmits<{
  action: [action: MessageAction];
  quote: [];
  mentionHover: [part: MentionPart, anchor: HTMLElement];
  mentionLeave: [];
  mentionOpen: [part: MentionPart, anchor: HTMLElement];
  suggestion: [item: SuggestionItem, kind: 'context' | 'fn'];
  run: [run: RunId];
  runToggle: [run: RunId, collapsed: boolean];
  background: [run: RunId];
  link: [link: Link];
}>();

type Attachment = Extract<MessagePart, { type: 'attachment' }>;
/** What its runs attached, in order. */
const outputs = computed(() => props.carried.flatMap((m) => m.parts.flatMap((part, i) => (part.type === 'attachment' || part.type === 'link' ? [{ key: `${m.id}-${i}`, part }] : []))));

const split = computed(() => splitParts(props.message.parts));
/** A message that is only `!` invocations whose run cards show under it: the cards say it all, so no bubble. */
const onlyRuns = computed(() => split.value.shown.length > 0
  && split.value.shown.every((part) => part.type === 'invocation' && props.runs.some((run) => run.id === part.run)));
/** What else went to the model with the message; the suggestions are left out, as their chips beside the time list them. */
const added = computed(() => split.value.added.flatMap((part: MessagePart) => (part.type === 'extra' || part.type === 'hook' ? part.blocks : []))
  .filter((block) => block.type !== 'suggest-context' && block.type !== 'suggest-fns'));
const addedText = computed(() => added.value.map((block) => {
  switch (block.type) {
    case 'text': return `<${block.tag}> ${block.text}`;
    case 'load': return `Loaded: ${[...(block.context ?? []), ...(block.fns ?? [])].join(', ')}`;
  }
}));
const showAdded = ref(false);
const body = ref<HTMLElement | null>(null);
const long = ref(false);
const expanded = ref(false);
const touchMore = ref(false);

onMounted(() => {
  const el = body.value;
  if (el === null) { return; }
  const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 22;
  long.value = el.scrollHeight > line * (props.clampLines + 1);
});
</script>

<template>
  <div
    :id="`m-${message.id}`" class="user-message" :class="{ mine, flash, 'touch-more': touchMore }" data-testid="user-message" :data-message="message.id"
    tabindex="-1"
  >
    <UiAvatar v-if="!mine" class="avatar" :name="authorName" :size="28" />
    <div class="column" :class="{ 'has-runs': runs.length > 0 }">
      <span v-if="!mine" class="author">{{ authorName }}</span>
      <button v-if="quote" type="button" class="quote" data-testid="reply-quote" @click="emit('quote')">
        <UiIcon name="reply" :size="12" />
        <span class="quote-author">{{ quote.author }}</span>
        <span class="quote-text">{{ quote.excerpt }}</span>
      </button>
      <div v-if="!onlyRuns" class="bubble" :class="{ clamped: long && !expanded, failed: message.status === 'failed' }" :style="{ '--lines': clampLines }">
        <div ref="body" class="body">
          <PartList
            :parts="split.shown" :command-name="commandName"
            @hover="(part, anchor) => emit('mentionHover', part, anchor)" @leave="emit('mentionLeave')" @open="(part, anchor) => emit('mentionOpen', part, anchor)"
            @run="emit('run', $event)"
          />
        </div>
        <button v-if="long" type="button" class="more" @click="expanded = !expanded">{{ expanded ? 'Show less' : 'Show more' }}</button>
      </div>
      <div v-if="runs.length > 0" class="runs">
        <RunCard
          v-for="run in runs" :key="run.id" :run="run" :now="now" :collapsed="collapsed(run)" :view="viewOf(run)" :byline="mine ? 'You ran this' : `${authorName} ran this`"
          @open="emit('run', run.id)" @toggle="emit('runToggle', run.id, $event)" @background="emit('background', run.id)"
        />
        <template v-for="output in outputs" :key="output.key">
          <AttachmentCard
            v-if="output.part.type === 'attachment'" :title="output.part.title" :attachment="output.part.attachment" :data="output.part.data" :view="attachmentView(output.part)"
          />
          <LinkCard v-else :link="output.part.link" @open="emit('link', $event)" />
        </template>
      </div>
      <div class="meta">
        <time class="time" :datetime="new Date(message.createdAt).toISOString()" :title="fullTime(message.createdAt)">{{ relativeTime(message.createdAt, now) }}</time>
        <SuggestionChips :suggestions="suggestions" @use="(item, kind) => emit('suggestion', item, kind)" />
        <button
          v-if="added.length > 0" type="button" class="added-toggle touch-target" data-testid="added-for-model" title="Added for the model"
          aria-label="Added for the model" :aria-expanded="showAdded ? 'true' : 'false'" @click="showAdded = !showAdded"
        >
          <UiIcon name="layers" :size="14" />
        </button>
        <button type="button" class="more-tap" aria-label="More actions" @click="touchMore = !touchMore"><UiIcon name="more" :size="16" /></button>
        <MessageActions class="actions" :actions="actions" @action="emit('action', $event)" />
      </div>
      <ul v-if="showAdded && added.length > 0" class="added-list" data-testid="added-list">
        <li v-for="(line, i) in addedText" :key="i">{{ line }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.user-message { display: flex; gap: var(--space-3); justify-content: flex-start; min-width: 0; padding: var(--space-1) 0; border-radius: var(--radius-lg); animation: ui-rise-in var(--medium) var(--ease); }
.user-message.mine { justify-content: flex-end; }
.user-message:focus { outline: none; }
.avatar { flex: none; margin-top: 18px; }
.column { display: grid; justify-items: start; gap: var(--space-1); min-width: 0; max-width: min(85%, var(--readable)); }
/* a run card needs room to show its renderer, however short the message that started it */
/* with runs it takes the answer column's width (all but the agent's avatar), so cards line up across the thread */
.column.has-runs { width: calc(100% - 28px - var(--space-3)); max-width: none; }
.runs { display: grid; gap: var(--space-2); justify-self: stretch; min-width: 0; }
.mine .column { justify-items: end; }
.author { font-size: var(--text-xs); color: var(--text-faint); padding: 0 var(--space-2); }
.quote {
  display: flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px var(--space-2); border: 0; border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); text-align: left;
}
.quote-author { flex: none; font-weight: var(--weight-medium); }
.quote-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bubble {
  position: relative; display: grid; min-width: 0; max-width: 100%; padding: var(--space-2) var(--space-4); border-radius: var(--radius-lg);
  background: var(--surface-2); color: var(--text); line-height: var(--leading);
}
.mine .bubble { background: var(--accent); color: var(--on-accent); border-bottom-right-radius: var(--radius-sm); }
.user-message:not(.mine) .bubble { border-bottom-left-radius: var(--radius-sm); }
.bubble.failed { box-shadow: inset 0 0 0 1px var(--danger); }
.body { min-width: 0; }
.clamped .body { max-height: calc(var(--lines) * 1lh); overflow: hidden; mask-image: linear-gradient(to bottom, #000 60%, transparent); }
.more { justify-self: start; margin-top: var(--space-1); padding: 0; border: 0; background: transparent; color: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); text-decoration: underline; }
.added-toggle { display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--radius-full); background: transparent; color: var(--text-faint); }
.added-toggle:hover, .added-toggle[aria-expanded='true'] { color: var(--text-dim); background: var(--surface-2); }
.added-toggle:focus-visible { outline: none; box-shadow: var(--ring); }
.added-list { max-width: 100%; margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--surface-2); color: var(--text-faint); font-size: var(--text-xs); list-style: none; overflow-wrap: anywhere; }
.meta { display: flex; align-items: center; gap: 2px; min-height: 28px; }
.mine .meta { flex-direction: row-reverse; }
.time { padding: 0 var(--space-1); color: var(--text-faint); font-size: var(--text-xs); }
.actions { opacity: 0; transition: opacity var(--fast) var(--ease); }
.user-message:hover .actions, .user-message:focus-within .actions, .touch-more .actions { opacity: 1; }
.more-tap { display: none; place-items: center; width: 32px; height: 32px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text-faint); }
@media (hover: none) {
  .more-tap { display: grid; }
  .actions { display: none; }
  .touch-more .actions { display: inline-flex; opacity: 1; }
}
.flash { animation: ui-flash 1.6s var(--ease); }
</style>
