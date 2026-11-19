<script setup lang="ts">
/**
 * An approval on a system page (`components.Approval`): the app's approval card for one waiting run. Answered in a
 * chat (`inChat`, the page's `host.runs`), the answer may be remembered as the chat's rules allow; outside one (the
 * inbox's, `host.inbox`) every answer is for this run only.
 */
import type { Json, Remember } from '@harness/core';
import type { ApprovalProps } from '@harness/sdk';
import ApprovalCard from '../components/approvals/ApprovalCard.vue';
import { isRememberable } from '../components/approvals/rules.ts';

withDefaults(defineProps<ApprovalProps>(), { inChat: false, description: '' });
const emit = defineEmits<{ decide: [approve: boolean, remember: Remember, reason: string, answer: Json | undefined] }>();
</script>

<template>
  <ApprovalCard
    :ident="approval.id" :data-approval="approval.id" :fn="approval.fn" :description="description" :args="undefined" :preview="approval.preview"
    :rememberable="inChat && isRememberable(approval)" :ask="approval.ask"
    @decide="(approve, remember, reason, answer) => emit('decide', approve, remember, reason, answer)"
  />
</template>
