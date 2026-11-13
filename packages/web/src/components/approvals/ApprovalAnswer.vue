<script setup lang="ts">
/**
 * The answer row of an approval, wherever it is asked (its card, the dialog that shows a cut card whole): how long to
 * remember the answer where that is allowed, then Deny (which opens a field for an optional reason) and Approve. With
 * `review` (the card is cut, so what the run will do isn't all in sight), Approve gives way to Review, which asks for
 * the whole of it first.
 */
import type { Remember } from '@harness/core';
import { ref, watch } from 'vue';
import { UiButton, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';

const props = withDefaults(defineProps<{
  /** Whether "this chat" and "always" are offered; otherwise every answer is for this run only. */
  rememberable?: boolean;
  /** Whether running it can't be undone, which colours Approve as a danger. */
  irreversible?: boolean;
  /** Changes when another approval takes the row, which clears a half-typed reason. */
  ident?: string;
  /** Approve gives way to Review: what the run will do isn't all in sight. */
  review?: boolean;
  /** Approve waits: the card's form (`ask`) has no value that fits yet. */
  blocked?: boolean;
  /** The word on Approve ("Answer" for a question). */
  approveLabel?: string;
}>(), { rememberable: true, irreversible: false, ident: '', review: false, blocked: false, approveLabel: 'Approve' });
const emit = defineEmits<{ decide: [approve: boolean, remember: Remember, reason: string]; review: [] }>();
defineSlots<{ buttons?: (scope: { remember: Remember }) => unknown }>();

const REMEMBER: readonly SegmentOption<Remember>[] = [{ value: 'once', label: 'Once' }, { value: 'session', label: 'This chat' }, { value: 'always', label: 'Always' }];

/** How long to remember the answer, shared by every row that asks about the same run. */
const remember = defineModel<Remember>('remember', { default: 'once' });
const denying = ref(false);
const reason = ref('');

watch(() => props.ident, () => { denying.value = false; reason.value = ''; });

function decide(approve: boolean): void {
  emit('decide', approve, props.rememberable ? remember.value : 'once', approve ? '' : reason.value.trim());
}
</script>

<template>
  <div class="answer">
    <UiInput v-if="denying" v-model="reason" label="Why not? (optional)" placeholder="Tell the agent what to do instead" size="sm" autofocus @enter="decide(false)" />
    <div class="row">
      <UiSegmented v-if="rememberable" v-model="remember" :options="REMEMBER" label="Remember this answer" />
      <div class="buttons">
        <slot name="buttons" :remember="remember" />
        <UiButton v-if="!denying" size="sm" variant="secondary" data-testid="deny" @click="denying = true">Deny</UiButton>
        <UiButton v-else size="sm" variant="danger" data-testid="deny-confirm" @click="decide(false)">Deny</UiButton>
        <UiButton v-if="review" size="sm" :variant="irreversible ? 'danger' : 'primary'" icon="eye" data-testid="review" @click="emit('review')">Review</UiButton>
        <UiButton v-else size="sm" :variant="irreversible ? 'danger' : 'primary'" icon="check" data-testid="approve" :disabled="blocked" @click="decide(true)">{{ approveLabel }}</UiButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.answer { display: grid; gap: var(--space-3); width: 100%; min-width: 0; }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); margin-left: auto; }
</style>
