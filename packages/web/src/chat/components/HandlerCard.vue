<script setup lang="ts">
/**
 * A run asking the person something through one of its handlers ("Overwrite README.md?", "Pick a folder"), sitting
 * with the approvals above the composer. A yes-or-no question (a handler that returns a bool, such as the shell's
 * confirm) looks like an approval: the question, the call's args, and explicit buttons named for what they do
 * ("Run" / "Cancel"). Any other question gets a form for the answer, generated from the handler's return type.
 */
import type { HandlerCall, Json } from '@harness/core';
import { computed } from 'vue';
import { UiButton, UiIcon } from '../../ui/index.ts';
import GinForm from '../../gin/GinForm.vue';
import { confirmVerb, humanize, isConfirm } from '../logic/labels.ts';
import ArgList from './ArgList.vue';

const props = withDefaults(defineProps<{ call: HandlerCall; fnLabel: string; busy?: boolean }>(), { busy: false });
const emit = defineEmits<{ answer: [value: Json] }>();

/** A yes-or-no question: answered with two buttons instead of a form. */
const confirm = computed(() => isConfirm(props.call));
const question = computed(() => props.call.decl.description.trim() || `${humanize(props.call.handler)}?`);
const yes = computed(() => confirmVerb(question.value));
</script>

<template>
  <section
    class="handler" :class="{ confirm }" role="region" :aria-label="`${fnLabel} asks`" data-testid="handler-card" :data-call="call.id"
    :data-kind="confirm ? 'confirm' : 'form'"
  >
    <header class="head">
      <span class="icon"><UiIcon :name="confirm ? 'shield' : 'chat'" :size="16" /></span>
      <div class="titles">
        <h3 class="title">{{ question }}</h3>
        <p class="description">{{ fnLabel }} is waiting for your answer.</p>
      </div>
    </header>
    <ArgList :args="call.args" />
    <footer v-if="confirm" class="foot">
      <UiButton size="sm" variant="secondary" :disabled="busy" data-testid="handler-no" @click="emit('answer', false)">Cancel</UiButton>
      <UiButton size="sm" variant="primary" icon="check" :disabled="busy" data-testid="handler-yes" @click="emit('answer', true)">{{ yes }}</UiButton>
    </footer>
    <GinForm v-else :type="call.decl.returns" label="Your answer" submit-label="Answer" :busy="busy" :cancellable="false" @submit="emit('answer', $event)" />
  </section>
</template>

<style scoped>
.handler {
  --edge: var(--accent); --edge-soft: var(--accent-soft);
  display: grid; gap: var(--space-3); min-width: 0; max-height: 50dvh; overflow-y: auto; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--edge); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 0 0 3px var(--edge-soft);
  animation: ui-rise-in var(--medium) var(--ease);
}
.handler.confirm { --edge: var(--warn); --edge-soft: var(--warn-soft); }
.head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--edge-soft); color: var(--edge); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
</style>
