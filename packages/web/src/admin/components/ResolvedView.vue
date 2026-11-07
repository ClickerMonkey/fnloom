<script setup lang="ts">
/**
 * The resolved view: for a person (in a chat, when given), the one priority a message gets and where it came from,
 * what one message may spend, and every budget that applies with what is left, the tightest marked.
 */
import { SessionId, type ActorId, type ResolvedLimits } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { formatCost } from '../../chat/logic/format.ts';
import { UiBadge, UiButton, UiCard, UiInput, UiSelect, UiSkeleton, type SelectOption } from '../../ui/index.ts';
import { resolvedText, scopeText, type NameOf } from '../logic/limits.ts';
import type { ActorOption } from '../state/actors.ts';

const props = withDefaults(defineProps<{
  people: readonly ActorOption[];
  resolved: ResolvedLimits | undefined;
  loading: boolean;
  nameOf: NameOf;
  /** The person and chat from the URL. */
  user?: string;
  session?: string;
}>(), { user: '', session: '' });
const emit = defineEmits<{ resolve: [user: ActorId, session: SessionId | undefined] }>();

const person = ref(props.user);
const chat = ref(props.session);
watch(() => [props.user, props.session], ([u, s]) => { person.value = u ?? ''; chat.value = s ?? ''; });
const choices = computed<readonly SelectOption<string>[]>(() => [{ value: '', label: 'Choose a person…' }, ...props.people.map((p) => ({ value: p.id, label: p.name }))]);
const text = computed(() => (props.resolved === undefined ? undefined : resolvedText(props.resolved)));

function resolve(): void {
  const user = props.people.find((p) => p.id === person.value);
  if (user === undefined) { return; }
  const session = SessionId.safeParse(chat.value.trim());
  emit('resolve', user.id, session.success ? session.data : undefined);
}
</script>

<template>
  <div class="resolved">
    <UiCard title="Work it out" subtitle="What a message from this person would get right now.">
      <form class="ask" novalidate data-testid="resolve-form" @submit.prevent="resolve">
        <UiSelect v-model="person" :options="choices" label="Person" />
        <UiInput v-model="chat" label="In chat (optional)" placeholder="ses_…" />
        <UiButton type="submit" variant="primary" :loading="loading" :disabled="person === ''" class="go" data-testid="resolve">Work out</UiButton>
      </form>
    </UiCard>
    <UiSkeleton v-if="loading && resolved === undefined" shape="lines" :lines="5" />
    <UiCard v-else-if="resolved && text" title="Result" data-testid="resolved">
      <div class="result">
        <div class="headline">
          <div><p class="label">Priority</p><p class="big">{{ text.priority }}</p></div>
          <div><p class="label">Each message</p><p class="big">{{ text.turn }}</p></div>
        </div>
        <ul class="budgets">
          <li v-for="(budget, i) in resolved.budgets" :key="budget.rule" class="budget" :class="{ tightest: i === text.tightest }">
            <span class="where">{{ scopeText(budget.scope, nameOf) }}</span>
            <UiBadge v-if="i === text.tightest" tone="warn">Tightest</UiBadge>
            <span class="left">{{ formatCost(budget.remaining) }} left</span>
          </li>
          <li v-if="resolved.budgets.length === 0" class="budget none">No budgets apply.</li>
        </ul>
      </div>
    </UiCard>
  </div>
</template>

<style scoped>
.resolved { display: grid; gap: var(--space-4); }
.ask { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; gap: var(--space-3); }
.result { display: grid; gap: var(--space-4); }
.headline { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: var(--space-4); }
.label { margin: 0; color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); text-transform: uppercase; letter-spacing: 0.04em; }
.big { margin: var(--space-1) 0 0; font-size: var(--text-md); }
.budgets { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); list-style: none; overflow: hidden; }
.budget { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-3) var(--space-4); }
.budget + .budget { border-top: 1px solid var(--border); }
.budget.tightest { background: var(--warn-soft); }
.where { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.left { font-variant-numeric: tabular-nums; }
.none { color: var(--text-dim); }
@media (max-width: 759.98px) {
  .ask { grid-template-columns: minmax(0, 1fr); }
  .go { justify-self: end; }
}
</style>
