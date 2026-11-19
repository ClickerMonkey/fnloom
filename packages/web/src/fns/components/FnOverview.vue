<script setup lang="ts">
/**
 * One fn at a glance, the same in the chat's fn modal and on the fn page: what it does (description, kind, what it
 * does to data, whether it is free, its signature), a notice when it usually runs long, what a call costs and how long
 * it takes, the types it reads and writes and the fns it uses (each a `FnPill`, opening in the fn modal), and its examples a page at a
 * time. Its runs come in the `runs` slot, since each place has its own (the chat's, or all of them); the page adds its
 * own badges (paused, tags) in the `badges` slot.
 */
import { authorWritesExamples, type FnExampleView, type FnFacts, type FnSearchHit, type QualifiedName } from '@harness/core';
import { computed } from 'vue';
import { localName } from '../../chat/logic/labels.ts';
import { UiBadge, UiBanner, UiButton, UiSkeleton } from '../../ui/index.ts';
import FnPill from './FnPill.vue';
import { exampleCall, factFigures, jsonText, MODE_TONE, MODE_WORDS } from '../logic/facts.ts';

const props = withDefaults(defineProps<{
  name: QualifiedName;
  about: FnSearchHit | undefined;
  facts: FnFacts | undefined;
  loading: boolean;
  problem?: string;
  examples: readonly FnExampleView[];
  examplesTotal: number;
  /** Whether more examples are left to load. */
  moreExamples: boolean;
  examplesLoading: boolean;
  examplesProblem?: string;
  /** Show its description (off where the page's header already does). */
  describe?: boolean;
}>(), { problem: '', examplesProblem: '', describe: true });
const emit = defineEmits<{ more: []; retry: [] }>();
defineSlots<{ runs?: () => unknown; badges?: () => unknown }>();

const local = computed(() => localName(props.name));
const figures = computed(() => (props.facts === undefined ? [] : factFigures(props.facts)));
const mode = computed(() => props.facts?.mode ?? props.about?.mode);
const uses = computed(() => (props.facts?.uses ?? []).filter((fn) => fn !== props.name));
/** Who gives a fn its examples: a system's kind works them out (`KindDescription.examples`); a native fn's or agent's author writes them. */
const whoAddsExamples = computed(() => {
  const kind = props.facts?.kind;
  return kind !== undefined && !authorWritesExamples(kind)
    ? `its kind (${kind}) works one out when the hub describes it.`
    : 'its author adds them to its declaration (`examples`).';
});
</script>

<template>
  <div class="fn-overview" data-testid="fn-overview" :data-fn="name">
    <UiBanner v-if="problem !== ''" tone="danger">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <UiSkeleton v-else-if="loading && facts === undefined" :lines="4" />

    <section class="about">
      <p v-if="describe && about?.description" class="description">{{ about.description }}</p>
      <div class="badges">
        <UiBadge v-if="mode" :tone="MODE_TONE[mode]" :title="MODE_WORDS[mode].about" data-testid="fn-mode">{{ MODE_WORDS[mode].label }}</UiBadge>
        <UiBadge v-if="facts?.free" tone="ok">Free</UiBadge>
        <UiBadge v-if="facts?.kind && facts.kind !== 'native'">{{ facts.kind }}</UiBadge>
        <UiBadge v-if="about?.instance">{{ about.instance }}</UiBadge>
        <UiBadge v-if="about && !about.available" tone="warn" :title="about.blocked?.reason">Not available now</UiBadge>
        <slot name="badges" />
      </div>
      <code v-if="about?.signature" class="signature" data-testid="fn-signature">{{ about.signature }}</code>
      <p v-if="about && !about.available && about.blocked" class="dim">{{ about.blocked.reason }}</p>
    </section>

    <UiBanner v-if="facts?.notice" tone="neutral" data-testid="fn-notice">{{ facts.notice }}</UiBanner>

    <ul v-if="figures.length > 0" class="strip" data-testid="fn-facts">
      <li v-for="figure in figures" :key="figure.key" class="figure" :data-figure="figure.key">
        <span class="label">{{ figure.label }}</span>
        <span class="value">{{ figure.value }}</span>
        <span class="detail">{{ figure.detail }}</span>
      </li>
    </ul>

    <dl v-if="facts && (facts.reads.length > 0 || facts.writes.length > 0 || uses.length > 0)" class="uses" data-testid="fn-uses">
      <template v-if="facts.reads.length > 0">
        <dt>Reads</dt>
        <dd><code v-for="type in facts.reads" :key="type" class="chip">{{ type }}</code></dd>
      </template>
      <template v-if="facts.writes.length > 0">
        <dt>Writes</dt>
        <dd><code v-for="type in facts.writes" :key="type" class="chip write">{{ type }}</code></dd>
      </template>
      <template v-if="uses.length > 0">
        <dt>Uses</dt>
        <dd>
          <FnPill v-for="fn in uses" :key="fn" :name="fn" />
        </dd>
      </template>
    </dl>

    <section class="examples" data-testid="fn-examples">
      <h3 class="heading">Examples<span v-if="examplesTotal > 0" class="dim"> · {{ examplesTotal }}</span></h3>
      <p v-if="examplesProblem !== ''" class="bad" role="alert">{{ examplesProblem }}</p>
      <p v-else-if="examples.length === 0 && examplesLoading" class="dim">Loading…</p>
      <!-- every fn should have one: a fn without is flagged, saying who adds it -->
      <UiBanner v-else-if="examples.length === 0" tone="warn" data-testid="fn-no-examples">
        No examples. Every fn needs at least one: {{ whoAddsExamples }}
      </UiBanner>
      <ol v-else class="example-list">
        <li v-for="example in examples" :key="example.id" class="example">
          <p v-if="example.note" class="note">{{ example.note }}</p>
          <pre class="code">{{ exampleCall(local, example) }}</pre>
          <pre v-if="example.result !== undefined" class="code result"><span class="arrow">→ </span>{{ jsonText(example.result) }}</pre>
        </li>
      </ol>
      <UiButton v-if="moreExamples" size="sm" variant="ghost" :loading="examplesLoading" data-testid="fn-more-examples" @click="emit('more')">
        More examples ({{ examplesTotal - examples.length }} left)
      </UiButton>
    </section>

    <slot name="runs" />
  </div>
</template>

<style scoped>
.fn-overview { display: grid; gap: var(--space-4); min-width: 0; }
.about { display: grid; gap: var(--space-2); min-width: 0; }
.description { margin: 0; line-height: var(--leading); }
.badges { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.badges:empty { display: none; }
.signature {
  display: block; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2);
  font-size: var(--text-sm); overflow-wrap: anywhere; white-space: pre-wrap;
}
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); font-weight: normal; }
.bad { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr)); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.figure { display: grid; align-content: start; gap: 2px; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.label { color: var(--text-dim); font-size: var(--text-xs); }
.value { font-size: var(--text-md); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.detail { color: var(--text-faint); font-size: var(--text-xs); }
.uses { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-3); align-items: baseline; margin: 0; }
.uses dt { color: var(--text-dim); font-size: var(--text-sm); }
.uses dd { display: flex; flex-wrap: wrap; gap: var(--space-1); min-width: 0; margin: 0; }
.chip {
  display: inline-flex; align-items: center; min-height: 24px; padding: 0 var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text); font-size: var(--text-xs); overflow-wrap: anywhere;
}
.chip.write { border-color: var(--warn); }
.examples { display: grid; gap: var(--space-2); min-width: 0; }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.example-list { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.example { display: grid; gap: var(--space-1); min-width: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.code { margin: 0; font-family: var(--mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.result { color: var(--text-dim); }
.arrow { color: var(--text-faint); }
.examples > :deep(.ui-button) { justify-self: start; }
</style>
