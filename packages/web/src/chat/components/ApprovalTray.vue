<script setup lang="ts">
/**
 * Runs waiting for approval, just above the composer so they can't be lost at the foot of a long thread. The oldest
 * shows first as an approval card (what it will do, then Approve or Deny with how long to remember the answer where
 * that is allowed). With several waiting, a count and Approve all / Deny all.
 */
import type { ApprovalId, Remember } from '@harness/core';
import { computed } from 'vue';
import ApprovalCard from '../../components/approvals/ApprovalCard.vue';
import { UiBadge, UiButton } from '../../ui/index.ts';
import type { ApprovalView } from './types.ts';

const props = defineProps<{ items: readonly ApprovalView[] }>();
const emit = defineEmits<{ decide: [id: ApprovalId, approve: boolean, remember: Remember, reason: string]; decideAll: [approve: boolean, remember: Remember] }>();

const current = computed(() => props.items[0]);

function decide(approve: boolean, remember: Remember, reason: string): void {
  const item = current.value;
  if (item !== undefined) { emit('decide', item.id, approve, remember, reason); }
}
</script>

<template>
  <ApprovalCard
    v-if="current" class="tray" :data-approval="current.id" :ident="current.id" :fn="current.fn" :description="current.description" :args="current.args"
    :preview="current.preview" :rememberable="current.rememberable" @decide="decide"
  >
    <template v-if="items.length > 1" #badge><UiBadge tone="warn" data-testid="approvals-waiting">{{ items.length }} waiting</UiBadge></template>
    <template v-if="items.length > 1" #buttons="{ remember }">
      <UiButton size="sm" variant="ghost" data-testid="deny-all" @click="emit('decideAll', false, remember)">Deny all</UiButton>
      <UiButton size="sm" variant="ghost" data-testid="approve-all" @click="emit('decideAll', true, remember)">Approve all</UiButton>
    </template>
  </ApprovalCard>
</template>

<style scoped>
.tray { max-height: 45dvh; overflow-y: auto; animation: ui-rise-in var(--medium) var(--ease); }
</style>
