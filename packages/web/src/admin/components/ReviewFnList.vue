<script setup lang="ts">
/**
 * A system's fns as its review shows them: one row each with its switch, name, description, what it does to data,
 * whether it is free, its kind and what it changes in the hub. Opening a row shows its instructions, its signature
 * (args and result types), the types it reads and writes, the fns it uses, its cost estimate and its examples, a link
 * to its own page (where its visibility is set) and a test call.
 */
import { owesExamples, type QualifiedName } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { ref } from 'vue';
import { localName } from '../../chat/logic/labels.ts';
import FnPill from '../../fns/components/FnPill.vue';
import GinTypeView from '../../gin/GinTypeView.vue';
import { UiBadge, UiButton, UiIcon, UiSwitch } from '../../ui/index.ts';
import { costText, exampleCall, MODE_TONE, MODE_WORDS } from '../../fns/logic/facts.ts';
import { timeText, type FnReview } from '../logic/review.ts';
import { NO_EXAMPLES_WHY } from '../logic/systems.ts';

withDefaults(defineProps<{
  fns: readonly FnReview[];
  /** Whether switches can be used now (not while one is being sent). */
  busy?: boolean;
  /** Offer a test call on each fn. */
  testable?: boolean;
  /** A fn's own page, where its visibility is set; no link when absent. */
  pageOf?: ((fn: QualifiedName) => RouteLocationRaw) | undefined;
}>(), { busy: false, testable: true, pageOf: undefined });
const emit = defineEmits<{ switch: [fn: QualifiedName, on: boolean]; test: [fn: FnReview] }>();

const open = ref<QualifiedName | undefined>(undefined);
const toggle = (name: QualifiedName): void => { open.value = open.value === name ? undefined : name; };
</script>

<template>
  <ul class="fns" data-testid="review-fns">
    <li v-for="item in fns" :key="item.name" :data-fn="item.name" :class="{ off: !item.on, open: open === item.name }">
      <div class="row">
        <UiSwitch :model-value="item.on" :label="`Use ${item.name}`" hide-label :disabled="busy" data-testid="review-fn-switch" @update:model-value="emit('switch', item.name, $event)" />
        <button type="button" class="head" :aria-expanded="open === item.name" data-testid="review-fn" @click="toggle(item.name)">
          <span class="main">
            <code class="name">{{ localName(item.name) }}</code>
            <span class="about">{{ item.decl.description }}</span>
            <span v-if="item.effects" class="effects" data-testid="review-fn-effects">{{ item.effects }}</span>
          </span>
          <span class="badges">
            <UiBadge v-if="item.facts" :tone="MODE_TONE[item.facts.mode]" :title="MODE_WORDS[item.facts.mode].about">{{ MODE_WORDS[item.facts.mode].label }}</UiBadge>
            <UiBadge v-if="item.facts?.free" tone="ok">Free</UiBadge>
            <UiBadge v-if="item.decl.kind !== 'native'">{{ item.decl.kind }}</UiBadge>
            <UiBadge v-if="item.decl.approval" tone="warn">Asks first</UiBadge>
            <UiBadge v-if="owesExamples(item.decl)" tone="warn" :title="NO_EXAMPLES_WHY" data-testid="review-fn-no-examples">No examples</UiBadge>
          </span>
          <UiIcon :name="open === item.name ? 'chevron-down' : 'chevron-right'" :size="14" class="chev" />
        </button>
      </div>
      <div v-if="open === item.name" class="body" data-testid="review-fn-body">
        <section v-if="item.decl.instructions" class="block">
          <h4 class="label">Instructions</h4>
          <p class="text">{{ item.decl.instructions }}</p>
        </section>
        <section class="block sig">
          <div class="side"><h4 class="label">Args</h4><GinTypeView :model-value="item.decl.args" readonly label="Args" /></div>
          <div class="side"><h4 class="label">Returns</h4><GinTypeView :model-value="item.decl.returns" readonly label="Returns" /></div>
        </section>
        <dl class="facts" data-testid="review-fn-facts">
          <div><dt>Kind</dt><dd>{{ item.facts?.kind ?? item.decl.kind }}</dd></div>
          <template v-if="item.facts">
            <div><dt>Mode</dt><dd :title="MODE_WORDS[item.facts.mode].about">{{ MODE_WORDS[item.facts.mode].label }}</dd></div>
            <div><dt>Cost a call</dt><dd>{{ costText(item.facts.cost) }}</dd></div>
            <div><dt>Time</dt><dd>{{ timeText(item.facts) }}</dd></div>
            <div><dt>Reads</dt><dd><code v-for="type in item.facts.reads" :key="type">{{ type }}</code><span v-if="item.facts.reads.length === 0" class="none">No types</span></dd></div>
            <div><dt>Writes</dt><dd><code v-for="type in item.facts.writes" :key="type">{{ type }}</code><span v-if="item.facts.writes.length === 0" class="none">No types</span></dd></div>
            <div v-if="item.facts.uses.some((fn) => fn !== item.name)"><dt>Uses</dt><dd><FnPill v-for="fn in item.facts.uses.filter((used) => used !== item.name)" :key="fn" :name="fn" /></dd></div>
          </template>
          <div><dt>Changes in the hub</dt><dd>{{ item.effects ?? 'Nothing' }}</dd></div>
        </dl>
        <p v-if="!item.facts" class="none" data-testid="review-fn-no-facts">Its mode, cost, time and the types it reads and writes can’t be worked out right now: the system that runs its kind may be away.</p>
        <section v-if="(item.decl.examples?.length ?? 0) > 0" class="block">
          <h4 class="label">Examples</h4>
          <ul class="examples">
            <li v-for="(example, index) in item.decl.examples" :key="index">
              <code>{{ exampleCall(item.decl.name, example) }}</code>
              <span v-if="example.note" class="note">{{ example.note }}</span>
            </li>
          </ul>
        </section>
        <div v-if="testable || pageOf" class="actions">
          <RouterLink v-if="pageOf" :to="pageOf(item.name)" class="page" data-testid="review-fn-page">Visibility and details</RouterLink>
          <UiButton v-if="testable" size="sm" icon="play" data-testid="review-fn-test" @click="emit('test', item)">Test call</UiButton>
        </div>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.fns { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.fns > li + li { border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; padding-left: var(--space-4); }
.head {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-2) var(--space-3); width: 100%;
  padding: var(--space-2) var(--space-4) var(--space-2) var(--space-3); border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.row:hover, .open > .row { background: var(--surface-2); }
.head:focus-visible { outline: none; box-shadow: inset var(--ring); }
.off .main { opacity: 0.6; }
.main { display: grid; gap: 2px; min-width: 0; }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.about { color: var(--text-dim); font-size: var(--text-sm); }
.effects { color: var(--warn); font-size: var(--text-xs); }
.badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1); }
.chev { color: var(--text-faint); }
.body { display: grid; gap: var(--space-3); padding: var(--space-3) var(--space-4) var(--space-4); min-width: 0; }
.block { display: grid; gap: var(--space-1); min-width: 0; }
.label { margin: 0; color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); text-transform: uppercase; letter-spacing: 0.04em; }
.text { margin: 0; font-size: var(--text-sm); white-space: pre-wrap; }
.sig { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
.side { display: grid; gap: var(--space-1); min-width: 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2) var(--space-4); margin: 0; }
.facts dt { color: var(--text-faint); font-size: var(--text-xs); }
.facts dd { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; font-size: var(--text-sm); }
.none { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.examples { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.examples code { font-size: var(--text-xs); overflow-wrap: anywhere; }
.note { margin-left: var(--space-2); color: var(--text-dim); font-size: var(--text-xs); }
.actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.page { font-size: var(--text-sm); }
@media (max-width: 559.98px) {
  .head { grid-template-columns: minmax(0, 1fr) auto; }
  .badges { grid-column: 1; grid-row: 2; justify-content: flex-start; }
  .chev { grid-row: 1; grid-column: 2; }
}
</style>
