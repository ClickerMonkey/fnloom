<script setup lang="ts">
/**
 * Runs waiting for approval, just above the composer so they can't be lost at the foot of a long thread. The oldest
 * shows as an approval card (what it will do, then Approve or Deny with how long to remember the answer where that
 * is allowed); its buttons stay in sight, and a body too tall for the room is cut and shown whole on Review. With several waiting, the rest are listed under
 * it, and Deny all answers every one while Approve all answers only those with no preview: a write or schema change is
 * approved from its own card, once the person has seen what it does. Each listed one names its fn as a `FnPill`.
 */
import type { ApprovalId, Json, Remember } from '@harness/core';
import { computed } from 'vue';
import ApprovalCard from '../../components/approvals/ApprovalCard.vue';
import { approvableTogether } from '../../components/approvals/rules.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { UiButton, UiIcon } from '../../ui/index.ts';
import { useFnNotice } from '../../fns/state/fn-notices.ts';
import type { ApprovalView } from './types.ts';

const props = defineProps<{ items: readonly ApprovalView[] }>();
const emit = defineEmits<{ decide: [id: ApprovalId, approve: boolean, remember: Remember, reason: string, answer: Json | undefined]; decideAll: [ids: ApprovalId[], approve: boolean, remember: Remember] }>();

/** How many of the others are listed by name. */
const LISTED = 3;
const noticeOf = useFnNotice();

const current = computed(() => props.items[0]);
const others = computed(() => props.items.slice(1));
const together = computed(() => approvableTogether(props.items).map((item) => item.id));

function decide(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): void {
  const item = current.value;
  if (item !== undefined) { emit('decide', item.id, approve, remember, reason, answer); }
}
</script>

<template>
  <ApprovalCard
    v-if="current" class="tray" bounded :data-approval="current.id" :ident="current.id" :fn="current.fn" :description="current.description" :args="current.args"
    :preview="current.preview" :rememberable="current.rememberable" :notice="noticeOf(current.fn)" :ask="current.ask" @decide="decide"
  >
    <template v-if="others.length > 0" #after>
      <div class="others" data-testid="approvals-others">
        <span class="lead">{{ others.length === 1 ? 'Also waiting' : `${others.length} more waiting` }}</span>
        <ul>
          <li v-for="item in others.slice(0, LISTED)" :key="item.id">
            <FnPill class="name" :name="item.fn" :label="item.preview?.title" />
            <span v-if="item.preview" class="own" title="It has a preview, so it is approved from its own card"><UiIcon name="shield" :size="12" />own answer</span>
          </li>
          <li v-if="others.length > LISTED" class="rest">and {{ others.length - LISTED }} more</li>
        </ul>
      </div>
    </template>
    <template v-if="others.length > 0" #buttons="{ remember }">
      <UiButton size="sm" variant="ghost" data-testid="deny-all" @click="emit('decideAll', items.map((item) => item.id), false, remember)">Deny all</UiButton>
      <UiButton
        v-if="together.length > 1" size="sm" variant="ghost" data-testid="approve-all" :title="`Approves the ${together.length} with nothing more to show; the rest wait for their own answer`"
        @click="emit('decideAll', together, true, remember)"
      >
        {{ together.length === items.length ? 'Approve all' : `Approve ${together.length}` }}
      </UiButton>
    </template>
  </ApprovalCard>
</template>

<style scoped>
.tray { max-height: min(42dvh, 440px); animation: ui-rise-in var(--medium) var(--ease); }
.others { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); min-width: 0; color: var(--text-dim); font-size: var(--text-xs); }
.lead { font-weight: var(--weight-strong); }
ul { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); min-width: 0; margin: 0; padding: 0; list-style: none; }
li { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; }
.name { min-width: 0; }
.own { display: inline-flex; align-items: center; gap: 2px; color: var(--warn); }
.rest { color: var(--text-faint); }
</style>
