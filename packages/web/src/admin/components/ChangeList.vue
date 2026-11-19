<script setup lang="ts">
/**
 * What waits for review after a system went live, grouped: what it may do first (grants, config), then each section
 * of what it offers, then everything it added while running, together and a page at a time (a running system can add
 * many). Each change is a card drawn the way its tab draws it (`PendingChange`), with its own Approve and Decline.
 */
import type { ContractChange, FnChangeFacts } from '@harness/core';
import { computed, ref } from 'vue';
import { UiButton } from '../../ui/index.ts';
import { changeGroups, changeKey, RUNTIME_PAGE } from '../logic/review.ts';
import PendingChange from './pending/PendingChange.vue';

const props = withDefaults(defineProps<{
  changes: readonly ContractChange[];
  /** Each changed fn's facts before and after, by name. */
  facts?: readonly FnChangeFacts[];
  /** The key (`changeKey`) of the change being decided now. */
  deciding?: string | undefined;
  /** A decision is under way (one change, or all of them). */
  busy?: boolean;
}>(), { facts: () => [], deciding: undefined, busy: false });
const emit = defineEmits<{ approve: [change: ContractChange]; decline: [change: ContractChange] }>();

const groups = computed(() => changeGroups(props.changes));
const factsOf = computed(() => new Map(props.facts.map((facts) => [facts.name, facts])));
/** How many runtime changes are shown. */
const shown = ref(RUNTIME_PAGE);
const visible = (changes: readonly ContractChange[], runtime: boolean): readonly ContractChange[] => (runtime ? changes.slice(0, shown.value) : changes);
</script>

<template>
  <div class="groups" data-testid="review-changes">
    <section v-for="group in groups" :key="group.key" class="group" :data-group="group.key">
      <h3 class="heading">{{ group.label }} <span class="count">{{ group.changes.length }}</span></h3>
      <TransitionGroup tag="div" name="change" class="list">
        <PendingChange
          v-for="change in visible(group.changes, group.runtime)" :key="changeKey(change)" :change="change" :facts="factsOf.get(change.name)"
          :busy="deciding === changeKey(change)" :disabled="busy" @approve="emit('approve', change)" @decline="emit('decline', change)"
        />
      </TransitionGroup>
      <UiButton
        v-if="group.runtime && group.changes.length > shown" class="more" variant="ghost" size="sm" data-testid="more-changes" @click="shown += RUNTIME_PAGE"
      >
        Show {{ Math.min(RUNTIME_PAGE, group.changes.length - shown) }} more of {{ group.changes.length - shown }}
      </UiButton>
    </section>
  </div>
</template>

<style scoped>
.groups { display: grid; gap: var(--space-4); min-width: 0; }
.group { display: grid; gap: var(--space-2); min-width: 0; }
.heading { display: flex; align-items: baseline; gap: var(--space-2); margin: 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.05em; }
.count { color: var(--text-faint); font-weight: var(--weight-medium); }
.list { display: grid; gap: var(--space-2); min-width: 0; }
.more { justify-self: start; }
.change-leave-active { transition: opacity 200ms ease, transform 200ms ease; }
.change-leave-to { opacity: 0; transform: translateX(12px); }
.change-move { transition: transform 200ms ease; }
@media (prefers-reduced-motion: reduce) { .change-leave-active, .change-move { transition: none; } }
</style>
