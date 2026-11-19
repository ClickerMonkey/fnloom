<script setup lang="ts">
/**
 * A type before and after a change (a table-backed type, or a table's type after a rescan): the change list first,
 * the saved fns it would break (each a `FnPill`), then the two types side by side (stacked when narrow) behind a toggle, so the card
 * stays short until someone wants the detail.
 */
import type { PreviewPart } from '@harness/core';
import { computed, ref } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import GinTypeView from '../../gin/GinTypeView.vue';
import { UiBadge, UiIcon } from '../../ui/index.ts';

type TypeDiffPart = Extract<PreviewPart, { type: 'type-diff' }>;
const props = defineProps<{ part: TypeDiffPart }>();

const open = ref(false);
const change = computed(() => (props.part.before === undefined ? 'New' : props.part.after === undefined ? 'Removed' : 'Changed'));
const tone = computed(() => (change.value === 'Removed' ? 'danger' : change.value === 'New' ? 'ok' : 'neutral'));
</script>

<template>
  <section class="diff" data-testid="type-diff">
    <header class="head">
      <UiIcon name="braces" :size="14" />
      <span class="name">{{ part.name }}</span>
      <UiBadge :tone="tone">{{ change }}</UiBadge>
    </header>
    <ul v-if="part.changes.length > 0" class="changes">
      <li v-for="line in part.changes" :key="line">{{ line }}</li>
    </ul>
    <div v-if="part.breaks.length > 0" class="breaks" data-testid="type-diff-breaks">
      <strong>Breaks {{ part.breaks.length === 1 ? 'a saved fn' : `${part.breaks.length} saved fns` }}</strong>
      <ul>
        <li v-for="item in part.breaks" :key="item.fn"><FnPill :name="item.fn" /> — {{ item.why }}</li>
      </ul>
    </div>
    <button type="button" class="toggle" :aria-expanded="open" @click="open = !open">{{ open ? 'Hide the types' : 'Compare the types' }}</button>
    <div v-if="open" class="sides">
      <div class="side">
        <span class="label">Before</span>
        <GinTypeView v-if="part.before" :model-value="part.before" readonly label="Before" />
        <span v-else class="none">No type yet</span>
      </div>
      <div class="side">
        <span class="label">After</span>
        <GinTypeView v-if="part.after" :model-value="part.after" readonly label="After" />
        <span v-else class="none">Removed</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.diff { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); container-type: inline-size; }
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; color: var(--text-dim); }
.name { flex: 1; min-width: 0; color: var(--text); font-family: var(--mono); font-size: var(--text-sm); overflow-wrap: anywhere; }
.changes, .breaks ul { display: grid; gap: 2px; margin: 0; padding-left: var(--space-4); font-size: var(--text-sm); }
.breaks { display: grid; gap: 2px; padding: var(--space-2); border-radius: var(--radius-sm); background: var(--warn-soft); font-size: var(--text-sm); }
.toggle { justify-self: start; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: var(--text-sm); }
.sides { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
@container (min-width: 620px) { .sides { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.side { display: grid; align-content: start; gap: var(--space-1); min-width: 0; }
.label { color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.04em; }
.none { color: var(--text-dim); font-size: var(--text-sm); }
</style>
