<script setup lang="ts">
/**
 * A run asking the person something through one of its handlers ("Overwrite README.md?", "Pick a folder"): what it
 * asks (the handler's description and args) and a form for the answer, generated from the handler's return type.
 * It sits with the approvals, above the composer.
 */
import type { HandlerCall, Json } from '@harness/core';
import { computed } from 'vue';
import { UiIcon } from '../../ui/index.ts';
import GinForm from '../forms/GinForm.vue';
import { humanize } from '../logic/labels.ts';

const props = withDefaults(defineProps<{ call: HandlerCall; fnLabel: string; busy?: boolean }>(), { busy: false });
const emit = defineEmits<{ answer: [value: Json] }>();

const question = computed(() => {
  const args = props.call.args;
  if (typeof args === 'string') { return args; }
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const text = Object.values(args).find((v) => typeof v === 'string');
    if (typeof text === 'string') { return text; }
  }
  return '';
});
</script>

<template>
  <section class="handler" role="region" :aria-label="`${fnLabel} asks`" data-testid="handler-card" :data-call="call.id">
    <header class="head">
      <span class="icon"><UiIcon name="chat" :size="16" /></span>
      <div class="titles">
        <h3 class="title">{{ fnLabel }} asks: {{ humanize(call.handler) }}</h3>
        <p class="description">{{ question || call.decl.description }}</p>
      </div>
    </header>
    <GinForm :type="call.decl.returns" label="Your answer" submit-label="Answer" :busy="busy" :cancellable="false" @submit="emit('answer', $event)" />
  </section>
</template>

<style scoped>
.handler {
  display: grid; gap: var(--space-3); min-width: 0; max-height: 50dvh; overflow-y: auto; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--accent); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 0 0 3px var(--accent-soft);
  animation: ui-rise-in var(--medium) var(--ease);
}
.head { display: flex; align-items: flex-start; gap: var(--space-3); }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.titles { display: grid; gap: 2px; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
</style>
