<script setup lang="ts">
/**
 * Under a user message, in its meta row: what the hub surfaced for it, as two small icons with a count (context, fns),
 * each shown only when something of that kind reached the turn. Opened, it lists what was used, best match first
 * (friendly name, system, score, why, how it reached the turn; picking one uses it: a context as its `/` command, a fn
 * as its `!` form), then what was looked at and left out, with the reason.
 */
import { computed, ref } from 'vue';
import { UiBadge, UiIcon, UiPopover } from '../../ui/index.ts';
import { SUGGESTION_DECIDER_LABELS, SUGGESTION_STATE, scoreText, skipText, type MessageSuggestions, type SkippedItem, type SuggestionItem } from '../logic/session.ts';

type Kind = 'context' | 'fn';

const props = defineProps<{ suggestions: MessageSuggestions }>();
const emit = defineEmits<{ use: [item: SuggestionItem, kind: Kind] }>();

const open = ref<Kind | undefined>(undefined);
const anchor = ref<HTMLElement | null>(null);
const used = (kind: Kind): readonly SuggestionItem[] => (kind === 'context' ? props.suggestions.context : props.suggestions.fns);
const skipped = (kind: Kind): readonly SkippedItem[] => (kind === 'context' ? props.suggestions.skippedContext : props.suggestions.skippedFns) ?? [];
const kinds = computed(() => (['context', 'fn'] as const).filter((kind) => used(kind).length > 0));
const label = (kind: Kind): string => (kind === 'fn' ? 'Suggested fns' : 'Suggested context');
const chooser = computed(() => {
  const { by, threshold } = props.suggestions;
  if (by === undefined) { return ''; }
  return threshold === undefined ? SUGGESTION_DECIDER_LABELS[by] : `${SUGGESTION_DECIDER_LABELS[by]} · threshold ${scoreText(threshold)}`;
});

function toggle(kind: Kind, event: MouseEvent): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) { return; }
  anchor.value = target;
  open.value = open.value === kind ? undefined : kind;
}

function use(item: SuggestionItem): void {
  const kind = open.value;
  open.value = undefined;
  if (kind !== undefined) { emit('use', item, kind); }
}
</script>

<template>
  <span v-if="kinds.length > 0" class="suggestions" data-testid="suggestion-chips">
    <button
      v-for="kind in kinds" :key="kind" type="button" class="icon touch-target" :data-testid="kind === 'fn' ? 'suggested-fns' : 'suggested-context'"
      :aria-label="`${label(kind)}: ${used(kind).length} used${skipped(kind).length > 0 ? `, ${skipped(kind).length} left out` : ''}`" :title="label(kind)"
      :aria-expanded="open === kind ? 'true' : 'false'" @click="toggle(kind, $event)"
    >
      <UiIcon :name="kind === 'fn' ? 'fn' : 'book'" :size="14" /><span class="count">{{ used(kind).length }}</span>
    </button>
    <UiPopover :open="open !== undefined" :anchor="anchor" side="bottom" align="end" :label="open === undefined ? '' : label(open)" @update:open="open = $event ? open : undefined">
      <div v-if="open !== undefined" class="pop">
        <p v-if="chooser !== ''" class="chooser">{{ chooser }}</p>
        <ul class="list">
          <li v-for="item in used(open)" :key="item.name">
            <button type="button" class="item" :title="item.name" @click="use(item)">
              <span class="top">
                <span class="name">{{ item.label }}</span>
                <span class="system">{{ item.system }}</span>
                <span v-if="item.score !== undefined" class="score" data-testid="suggestion-score" :title="`Match score ${item.score.toFixed(3)}`">{{ scoreText(item.score) }}</span>
                <UiBadge :tone="item.state === 'loaded' ? 'ok' : item.state === 'auto' ? 'accent' : 'neutral'">{{ SUGGESTION_STATE[item.state] }}</UiBadge>
              </span>
              <span v-if="item.why !== ''" class="why">{{ item.why }}</span>
            </button>
          </li>
        </ul>
        <template v-if="skipped(open).length > 0">
          <p class="heading">Left out</p>
          <ul class="list" data-testid="suggestions-skipped">
            <li v-for="item in skipped(open)" :key="item.name" class="item skipped" :title="item.name">
              <span class="top">
                <span class="name">{{ item.label }}</span>
                <span class="system">{{ item.system }}</span>
                <span v-if="item.score !== undefined" class="score" :title="`Match score ${item.score.toFixed(3)}`">{{ scoreText(item.score) }}</span>
              </span>
              <span class="why">{{ skipText(item) }}</span>
            </li>
          </ul>
        </template>
      </div>
    </UiPopover>
  </span>
</template>

<style scoped>
.suggestions { display: inline-flex; align-items: center; gap: 2px; }
.icon {
  display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 6px; border: 0; border-radius: var(--radius-full);
  background: transparent; color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums;
  transition: color var(--fast) var(--ease), background-color var(--fast) var(--ease);
}
.icon:hover, .icon[aria-expanded='true'] { color: var(--text-dim); background: var(--surface-2); }
.icon:focus-visible { outline: none; box-shadow: var(--ring); }
.count { font-weight: var(--weight-medium); }
.pop { display: grid; gap: 2px; width: min(360px, calc(100vw - 32px)); padding: var(--space-1); }
.chooser, .heading { margin: 0; padding: var(--space-1) var(--space-3) 0; color: var(--text-faint); font-size: var(--text-xs); }
.heading { padding-top: var(--space-2); font-weight: var(--weight-medium); }
.list { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
.item { display: grid; gap: 1px; width: 100%; padding: var(--space-1) var(--space-3); border: 0; border-radius: var(--radius); background: transparent; text-align: left; color: var(--text); }
button.item:hover, button.item:focus-visible { background: var(--surface-2); outline: none; }
.item.skipped { color: var(--text-dim); }
.top { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.name { min-width: 0; font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.system { margin-right: auto; color: var(--text-faint); font-size: var(--text-xs); }
.score { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.why { color: var(--text-dim); font-size: var(--text-sm); }
.skipped .why { color: var(--text-faint); font-size: var(--text-xs); }
</style>
