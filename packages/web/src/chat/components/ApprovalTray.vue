<script setup lang="ts">
/**
 * Runs waiting for approval, just above the composer so they can't be lost at the foot of a long thread. The oldest
 * shows first: the fn's label and description, its args in readable form (long values clamped behind Show more),
 * and Approve or Deny with how long to remember the answer (once, this session, always). Deny can carry a reason.
 * With several waiting, a count and Approve all / Deny all.
 */
import type { ApprovalId, Remember } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBadge, UiButton, UiIcon, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { fnLabel } from '../logic/labels.ts';
import ArgList from './ArgList.vue';
import type { ApprovalView } from './types.ts';

const props = defineProps<{ items: readonly ApprovalView[] }>();
const emit = defineEmits<{ decide: [id: ApprovalId, approve: boolean, remember: Remember, reason: string]; decideAll: [approve: boolean, remember: Remember] }>();

const REMEMBER: readonly SegmentOption<Remember>[] = [{ value: 'once', label: 'Once' }, { value: 'session', label: 'This chat' }, { value: 'always', label: 'Always' }];

const current = computed(() => props.items[0]);
const remember = ref<Remember>('once');
const denying = ref(false);
const reason = ref('');

watch(() => current.value?.id, () => { denying.value = false; reason.value = ''; });

function decide(approve: boolean): void {
  const item = current.value;
  if (item === undefined) { return; }
  emit('decide', item.id, approve, remember.value, approve ? '' : reason.value.trim());
}
</script>

<template>
  <section v-if="current" class="approval" role="region" aria-label="Approval needed" data-testid="approval-card" :data-approval="current.id">
    <header class="head">
      <span class="icon"><UiIcon name="shield" :size="16" /></span>
      <div class="titles">
        <h3 class="title">Allow {{ fnLabel(current.fn) }}?</h3>
        <p v-if="current.description !== ''" class="description">{{ current.description }}</p>
      </div>
      <UiBadge v-if="items.length > 1" tone="warn" data-testid="approvals-waiting">{{ items.length }} waiting</UiBadge>
    </header>
    <ArgList :args="current.args" />
    <UiInput v-if="denying" v-model="reason" label="Why not? (optional)" placeholder="Tell the agent what to do instead" size="sm" autofocus @enter="decide(false)" />
    <footer class="foot">
      <UiSegmented v-model="remember" :options="REMEMBER" label="Remember this answer" />
      <div class="buttons">
        <template v-if="items.length > 1">
          <UiButton size="sm" variant="ghost" data-testid="deny-all" @click="emit('decideAll', false, remember)">Deny all</UiButton>
          <UiButton size="sm" variant="ghost" data-testid="approve-all" @click="emit('decideAll', true, remember)">Approve all</UiButton>
        </template>
        <UiButton v-if="!denying" size="sm" variant="secondary" data-testid="deny" @click="denying = true">Deny</UiButton>
        <UiButton v-else size="sm" variant="danger" data-testid="deny-confirm" @click="decide(false)">Deny</UiButton>
        <UiButton size="sm" variant="primary" icon="check" data-testid="approve" @click="decide(true)">Approve</UiButton>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.approval {
  display: grid; gap: var(--space-3); min-width: 0; max-height: 45dvh; overflow-y: auto; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--warn); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 0 0 3px var(--warn-soft);
  animation: ui-rise-in var(--medium) var(--ease);
}
.head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); margin-left: auto; }
</style>
