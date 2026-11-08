<script setup lang="ts">
/**
 * The `review` form: the run waits in `await ctx.form()` until the person approves or refuses here; `view.submit` sends
 * the answer, checked against the contract's form type, and the agent gets it as the fn's result.
 */
import type { FnViewOf } from '@harness/sdk';
import { ref } from 'vue';
import type { notes } from '../shared/index.ts';

const view = defineProps<FnViewOf<typeof notes, 'review'>>();
const comment = ref('');

function answer(approved: boolean): void {
  const note = comment.value.trim();
  void view.submit({ approved, ...(note === '' ? {} : { note }) }).result;
}
</script>

<template>
  <form v-if="view.status === 'running'" class="review" @submit.prevent="answer(true)">
    <label class="field">Comment (optional)<input v-model="comment" type="text" autocomplete="off"></label>
    <div class="actions">
      <button type="button" @click="answer(false)">Refuse</button>
      <button type="submit" class="primary">Approve</button>
    </div>
  </form>
  <p v-else-if="view.result" class="answered">{{ view.result.approved ? 'Approved' : 'Refused' }}{{ view.result.note ? `: ${view.result.note}` : '' }}</p>
</template>

<style scoped>
.review { display: grid; gap: var(--space-2); }
.field { display: grid; gap: var(--space-1); font-size: var(--text-sm); }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.primary { background: var(--accent); color: var(--on-accent); }
.answered { margin: 0; color: var(--text-dim); }
</style>
