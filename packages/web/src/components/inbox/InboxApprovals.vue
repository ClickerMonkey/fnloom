<script setup lang="ts">
/**
 * The runs waiting for the person's approval, at the head of the inbox, each as an approval card answered right
 * there (for this run only; a chat offers remembering the answer). Hidden when nothing waits.
 */
import type { Approval, Json } from '@harness/core';
import { useFnNotice } from '../../fns/state/fn-notices.ts';
import ApprovalCard from '../approvals/ApprovalCard.vue';

defineProps<{ items: readonly Approval[] }>();
const emit = defineEmits<{ decide: [approval: Approval, approve: boolean, reason: string, answer: Json | undefined] }>();
const noticeOf = useFnNotice();
</script>

<template>
  <section v-if="items.length > 0" class="waiting" aria-label="Waiting for your approval" data-testid="inbox-approvals">
    <h2 class="title">Waiting for you <span class="count">{{ items.length }}</span></h2>
    <ApprovalCard
      v-for="item in items" :key="item.id" :data-approval="item.id" :ident="item.id" :fn="item.fn" description="" :args="undefined" :preview="item.preview"
      :rememberable="false" :notice="noticeOf(item.fn)" :ask="item.ask" @decide="(approve, _remember, reason, answer) => emit('decide', item, approve, reason, answer)"
    />
  </section>
</template>

<style scoped>
.waiting { display: grid; gap: var(--space-3); min-width: 0; }
.title { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.count { color: var(--text-dim); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
</style>
