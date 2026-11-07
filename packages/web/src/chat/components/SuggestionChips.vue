<script setup lang="ts">
/**
 * Under a user message: what the hub's index surfaced for it by meaning, as two small chips ("4 context", "3 fns")
 * shown only when there is something. Each opens a list with the item's friendly name, its system, why it matched,
 * and how it reached the turn (added, offered, or loaded by the agent). Picking one uses it: a context as its
 * `/` command, a fn as its `!` form.
 */
import { computed, ref } from 'vue';
import { UiBadge, UiIcon, UiPopover } from '../../ui/index.ts';
import { SUGGESTION_STATE, type MessageSuggestions, type SuggestionItem } from '../logic/session.ts';

const props = defineProps<{ suggestions: MessageSuggestions }>();
const emit = defineEmits<{ use: [item: SuggestionItem, kind: 'context' | 'fn'] }>();

const open = ref<'context' | 'fn' | undefined>(undefined);
const anchor = ref<HTMLElement | null>(null);
const shown = computed(() => (open.value === 'context' ? props.suggestions.context : open.value === 'fn' ? props.suggestions.fns : []));

function toggle(kind: 'context' | 'fn', event: MouseEvent): void {
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
  <div v-if="suggestions.context.length > 0 || suggestions.fns.length > 0" class="chips" data-testid="suggestion-chips">
    <button v-if="suggestions.context.length > 0" type="button" class="chip" data-testid="suggested-context" :aria-expanded="open === 'context' ? 'true' : 'false'" @click="toggle('context', $event)">
      <UiIcon name="sparkles" :size="12" /> {{ suggestions.context.length }} context
    </button>
    <button v-if="suggestions.fns.length > 0" type="button" class="chip" data-testid="suggested-fns" :aria-expanded="open === 'fn' ? 'true' : 'false'" @click="toggle('fn', $event)">
      <UiIcon name="fn" :size="12" /> {{ suggestions.fns.length }} fn{{ suggestions.fns.length === 1 ? '' : 's' }}
    </button>
    <UiPopover :open="open !== undefined" :anchor="anchor" side="bottom" align="end" :label="open === 'fn' ? 'Suggested fns' : 'Suggested context'" @update:open="open = $event ? open : undefined">
      <ul class="list">
        <li v-for="item in shown" :key="item.name">
          <button type="button" class="item" :title="item.name" @click="use(item)">
            <span class="top">
              <span class="name">{{ item.label }}</span>
              <UiBadge :tone="item.state === 'loaded' ? 'ok' : item.state === 'auto' ? 'accent' : 'neutral'">{{ SUGGESTION_STATE[item.state] }}</UiBadge>
            </span>
            <span class="system">{{ item.system }}</span>
            <span v-if="item.why !== ''" class="why">{{ item.why }}</span>
          </button>
        </li>
      </ul>
    </UiPopover>
  </div>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1); }
.chip {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 var(--space-2); border: 1px solid var(--border);
  border-radius: var(--radius-full); background: transparent; color: var(--text-faint); font-size: var(--text-xs);
  transition: color var(--fast) var(--ease), background-color var(--fast) var(--ease);
}
.chip:hover, .chip[aria-expanded='true'] { color: var(--text-dim); background: var(--surface-2); }
.chip:focus-visible { outline: none; box-shadow: var(--ring); }
.list { display: grid; gap: 2px; width: min(340px, calc(100vw - 32px)); margin: 0; padding: var(--space-1); list-style: none; }
.item { display: grid; gap: 2px; width: 100%; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius); background: transparent; text-align: left; color: var(--text); }
.item:hover, .item:focus-visible { background: var(--surface-2); outline: none; }
.top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.name { font-weight: var(--weight-medium); min-width: 0; overflow-wrap: anywhere; }
.system { color: var(--text-faint); font-size: var(--text-xs); }
.why { color: var(--text-dim); font-size: var(--text-sm); }
</style>
