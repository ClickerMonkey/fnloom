<script setup lang="ts">
/**
 * One cite of an answer as a small raised `[n]` chip in the text ("Use citations"). Hovering it (after a short pause,
 * on a screen with a pointer) or pressing it opens a popover: the model's words for why the value backs the claim, the
 * fn it came from, the value at its path in readable form (fields, items or text; JSON when deep, with the raw JSON a
 * press away), and "Show in result", which takes the person to the run's card. A cite that doesn't resolve (no such
 * tool call, nothing at that path) is drawn dashed and says why; one still streaming says it is being checked.
 */
import type { RunId } from '@harness/core';
import { computed, onBeforeUnmount, ref } from 'vue';
import { UiButton, UiCodeBlock, UiIcon, UiPopover } from '../../ui/index.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { citeAria, citeLabel, citeState, isSettledCite, pathLabel, readableValue, type ChatCite } from '../logic/cites.ts';
import type { RunView } from '../logic/runs.ts';

const props = withDefaults(defineProps<{
  cite: ChatCite;
  /** The run it cites, when the thread holds it (its result has a value too large to keep on the message). */
  run?: RunView | undefined;
}>(), { run: undefined });
const emit = defineEmits<{ show: [run: RunId] }>();

/** How long the pointer rests on the chip before its popover opens, and may wander off before it closes. */
const HOVER_OPEN = 250;
const HOVER_CLOSE = 300;

const anchor = ref<HTMLElement | null>(null);
const open = ref(false);
/** Opened by a press (it takes focus and stays) rather than by hovering (it follows the pointer). */
const pressed = ref(false);
const raw = ref(false);
const state = computed(() => citeState(props.cite, props.run));
const readable = computed(() => (state.value.kind === 'value' ? readableValue(state.value.value) : undefined));
const json = computed(() => (state.value.kind === 'value' ? JSON.stringify(state.value.value, null, 2) : ''));
const settled = computed(() => (isSettledCite(props.cite) ? props.cite : undefined));
const citedRun = computed(() => settled.value?.run);
const missing = computed(() => state.value.kind === 'problem');

let timer: ReturnType<typeof setTimeout> | undefined;
const hovers = (): boolean => typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;

function enter(): void {
  clearTimeout(timer);
  if (open.value || !hovers()) { return; }
  timer = setTimeout(() => { pressed.value = false; open.value = true; }, HOVER_OPEN);
}
function leave(): void {
  clearTimeout(timer);
  if (pressed.value) { return; }
  timer = setTimeout(() => { open.value = false; }, HOVER_CLOSE);
}
/** The pointer moved onto the popover: it stays open. */
function stay(): void { clearTimeout(timer); }
function press(): void {
  clearTimeout(timer);
  pressed.value = !open.value || !pressed.value;
  open.value = pressed.value;
}
function show(): void {
  if (citedRun.value === undefined) { return; }
  open.value = false;
  emit('show', citedRun.value);
}
onBeforeUnmount(() => { clearTimeout(timer); });
</script>

<template>
  <button
    ref="anchor" type="button" class="cite-chip" :class="{ missing, pending: state.kind === 'pending', open }" data-testid="cite-chip" :data-cite="cite.number"
    :aria-label="citeAria(cite)" :aria-expanded="open ? 'true' : 'false'" @mouseenter="enter" @mouseleave="leave" @click.stop="press" v-text="citeLabel(cite)"
  />
  <UiPopover v-model:open="open" :anchor="anchor" side="top" align="start" :take-focus="pressed" :label="`Citation ${cite.number}`">
    <div class="cite-card" data-testid="cite-card" @mouseenter="stay" @mouseleave="leave">
      <header class="head">
        <span class="number">{{ citeLabel(cite) }}</span>
        <FnPill v-if="settled?.fn" :name="settled.fn" />
        <code class="path" :title="cite.path">{{ pathLabel(cite.path) }}</code>
      </header>
      <p v-if="cite.note !== ''" class="note" data-testid="cite-note">{{ cite.note }}</p>
      <p v-else class="note dim">The model gave no reason.</p>
      <p v-if="state.kind === 'problem'" class="problem" data-testid="cite-problem"><UiIcon name="warning" :size="14" /><span>Not found: {{ state.problem }}</span></p>
      <p v-else-if="state.kind === 'pending'" class="dim">Checking the source once the answer is done.</p>
      <p v-else-if="state.kind === 'unloaded'" class="dim">The value is large: it is in the run’s result.</p>
      <div v-else-if="readable" class="value" data-testid="cite-value">
        <template v-if="raw"><UiCodeBlock :code="json" language="json" :max-height="240" /></template>
        <p v-else-if="readable.kind === 'text'" class="text">{{ readable.text }}</p>
        <ul v-else-if="readable.kind === 'items'" class="items"><li v-for="(item, i) in readable.items" :key="i">{{ item }}</li></ul>
        <dl v-else-if="readable.kind === 'fields'" class="fields">
          <template v-for="field in readable.fields" :key="field.key">
            <dt>{{ field.label }}</dt>
            <dd><pre v-if="field.long" class="long">{{ field.text }}</pre><template v-else>{{ field.text }}</template></dd>
          </template>
        </dl>
        <UiCodeBlock v-else :code="readable.json" language="json" :max-height="240" />
      </div>
      <footer v-if="citedRun !== undefined || state.kind === 'value'" class="foot">
        <button v-if="state.kind === 'value' && readable?.kind !== 'json'" type="button" class="raw" data-testid="cite-raw" @click="raw = !raw">{{ raw ? 'Readable' : 'JSON' }}</button>
        <UiButton v-if="citedRun !== undefined" size="sm" icon-right="arrow-right" data-testid="cite-show" @click="show">Show in result</UiButton>
      </footer>
    </div>
  </UiPopover>
</template>

<style scoped>
.cite-chip {
  display: inline-block; min-width: 1.6em; margin: 0 1px; padding: 0 4px; vertical-align: super; border: 1px solid color-mix(in oklab, var(--accent) 30%, transparent);
  border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent); font: inherit; font-size: 0.72em; font-weight: var(--weight-medium);
  line-height: 1.5; font-variant-numeric: tabular-nums; cursor: pointer; transition: background-color var(--fast) var(--ease);
}
.cite-chip:hover, .cite-chip.open { background: var(--accent-soft-strong); }
.cite-chip:focus-visible { outline: none; box-shadow: var(--ring); }
.cite-chip.missing { border-style: dashed; border-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
.cite-chip.pending { opacity: 0.7; }
/* a bigger target on touch screens, without moving the text */
@media (pointer: coarse) { .cite-chip { position: relative; } .cite-chip::after { content: ''; position: absolute; inset: -10px -6px; } }
.cite-card { display: grid; gap: var(--space-2); width: max-content; max-width: min(420px, calc(100vw - 32px)); padding: var(--space-3) var(--space-4); font-size: var(--text-sm); }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.number { color: var(--accent); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; }
.path { padding: 1px 5px; border-radius: 5px; background: var(--surface-3); color: var(--text-dim); font: 0.88em var(--mono); overflow-wrap: anywhere; }
.note { margin: 0; line-height: var(--leading); }
.dim { margin: 0; color: var(--text-faint); }
.problem { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; color: var(--warn); }
.problem :deep(svg) { flex: none; margin-top: 2px; }
.value { min-width: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--surface-2); }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.items { margin: 0; padding-left: 1.25em; }
.fields { display: grid; grid-template-columns: minmax(70px, auto) minmax(0, 1fr); gap: var(--space-1) var(--space-3); margin: 0; }
dt { color: var(--text-faint); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.long { margin: 0; max-height: 160px; overflow: auto; font: 0.88em var(--mono); white-space: pre-wrap; }
.foot { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); }
.raw { margin-right: auto; padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.raw:hover { text-decoration: underline; }
</style>
