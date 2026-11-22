<script setup lang="ts">
/**
 * One change waiting for review, drawn the way its tab draws it: a fn as its facts before and after with its
 * description as a prose diff, a type or the config type as a type diff, a context item's markdown as a rendered word
 * diff, the grants as a delta. Each says what it is (added, changed or removed) and where it came from, has its own
 * Approve and Decline, and a "Show raw diff" toggle for the declaration's JSON. Parts with no view of their own show
 * the raw diff at once. A change to what agents are told (an injection, or a hook's `explains`) also lists each target
 * with the agents it hits now (`InjectTargets`).
 */
import type { ContractChange, FnChangeFacts, InjectionChangeView } from '@harness/core';
import { computed, ref } from 'vue';
import TypeDiff from '../../../components/approvals/TypeDiff.vue';
import { DECLARED_WORDS } from '../../../context/logic/context.ts';
import { UiBadge, UiButton } from '../../../ui/index.ts';
import { CHANGE_LOOK, changeView, grantsOf, textOf, typeDiffPart } from '../../logic/review.ts';
import GrantsView from '../GrantsView.vue';
import FnFactsDiff from './FnFactsDiff.vue';
import MarkdownDiff from './MarkdownDiff.vue';
import FnPill from '../../../fns/components/FnPill.vue';
import InjectTargets from './InjectTargets.vue';
import ProseDiff from './ProseDiff.vue';
import RawDiff from './RawDiff.vue';

const props = withDefaults(defineProps<{
  change: ContractChange;
  /** Its facts, for a fn. */
  facts?: FnChangeFacts | undefined;
  /** What it changes in what agents are told, when it does. */
  injection?: InjectionChangeView | undefined;
  /** This change is being decided now. */
  busy?: boolean;
  /** Another decision is under way. */
  disabled?: boolean;
}>(), { facts: undefined, injection: undefined, busy: false, disabled: false });
const emit = defineEmits<{ approve: []; decline: [] }>();

const view = computed(() => changeView(props.change));
const raw = ref(false);
const showRaw = computed(() => raw.value || view.value === 'raw');
const description = computed(() => ({ before: textOf(props.change.before, 'description'), after: textOf(props.change.after, 'description') }));
const content = computed(() => ({ before: textOf(props.change.before, 'content'), after: textOf(props.change.after, 'content') }));
const look = computed(() => CHANGE_LOOK[props.change.change]);
</script>

<template>
  <article class="change" :class="change.change" :data-change="`${change.section}:${change.name}`" data-testid="review-change">
    <header class="head">
      <div class="title">
        <FnPill v-if="change.section === 'fns'" class="fn" :name="change.name" />
        <code v-else class="name">{{ change.name }}</code>
        <UiBadge :tone="look.tone">{{ look.word }}</UiBadge>
        <span class="origin">{{ DECLARED_WORDS[change.origin] }}</span>
      </div>
      <div class="actions">
        <UiButton
          v-if="view !== 'raw'" variant="ghost" size="sm" :icon="raw ? 'eye-off' : 'code'" :aria-pressed="raw" data-testid="toggle-raw-diff" @click="raw = !raw"
        >
          {{ raw ? 'Hide raw diff' : 'Show raw diff' }}
        </UiButton>
        <UiButton variant="ghost" size="sm" icon="x" :disabled="disabled || busy" data-testid="decline-change" @click="emit('decline')">Decline</UiButton>
        <UiButton variant="secondary" size="sm" icon="check" :loading="busy" :disabled="disabled" data-testid="approve-change" @click="emit('approve')">Approve</UiButton>
      </div>
    </header>
    <div v-if="view !== 'raw'" class="body">
      <FnFactsDiff v-if="view === 'fn'" :facts="facts" :before="description.before" :after="description.after" />
      <template v-else-if="view === 'type' || view === 'config-type'">
        <ProseDiff v-if="view === 'type' && description.before !== description.after" :before="description.before" :after="description.after" class="about" />
        <TypeDiff :part="typeDiffPart(change)" />
      </template>
      <template v-else-if="view === 'context'">
        <ProseDiff v-if="description.before !== description.after" :before="description.before" :after="description.after" class="about" />
        <MarkdownDiff v-if="content.before !== content.after" :before="content.before" :after="content.after" />
        <p v-else-if="content.after === undefined && content.before === undefined" class="dim">Written when it is used (dynamic context).</p>
        <p v-else class="dim">Its content is the same; only how it is offered changed (see the raw diff).</p>
      </template>
      <GrantsView v-else-if="view === 'grants'" :grants="grantsOf(change.after)" :before="change.change === 'added' ? undefined : grantsOf(change.before)" :delta="change.change !== 'added'" />
    </div>
    <InjectTargets v-if="injection" :injection="injection" />
    <RawDiff v-if="showRaw" :before="change.before" :after="change.after" />
  </article>
</template>

<style scoped>
.change {
  display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: var(--radius-lg); background: var(--surface); transition: border-color 160ms ease, box-shadow 160ms ease;
}
.change:hover { box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.06)); }
.change.added { border-left-color: var(--ok); }
.change.removed { border-left-color: var(--danger); }
.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.origin, .dim { color: var(--text-faint); font-size: var(--text-xs); }
.dim { margin: 0; font-size: var(--text-sm); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); margin-left: auto; }
.body { display: grid; gap: var(--space-2); min-width: 0; }
.about { font-size: var(--text-sm); }
@media (max-width: 559.98px) {
  .actions { width: 100%; justify-content: flex-end; }
}
</style>
