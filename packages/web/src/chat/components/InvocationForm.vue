<script setup lang="ts">
/**
 * The `!` form: a fn picked to run by hand, its args as a form generated from its gin type, stacked above the
 * composer (not a modal). Submitting runs it, and that submit is the approval.
 */
import type { Json } from '@harness/core';
import { UiIcon, UiIconButton } from '../../ui/index.ts';
import GinForm from '../../gin/GinForm.vue';
import { fnLabel } from '../logic/labels.ts';
import type { Invocation } from '../logic/composer.ts';

defineProps<{ invocation: Invocation; busy: boolean }>();
const emit = defineEmits<{ submit: [args: Json]; cancel: [] }>();
</script>

<template>
  <section class="invocation" role="region" :aria-label="`Run ${fnLabel(invocation.fn)}`" data-testid="invocation-form" :data-fn="invocation.fn">
    <header class="head">
      <span class="icon"><UiIcon name="fn" :size="16" /></span>
      <div class="titles">
        <h3 class="title">Run {{ fnLabel(invocation.fn) }}</h3>
        <p class="description">{{ invocation.description }}</p>
      </div>
      <UiIconButton size="sm" icon="x" label="Close" @click="emit('cancel')" />
    </header>
    <GinForm :type="invocation.args" label="Arguments" submit-label="Run" :busy="busy" @submit="emit('submit', $event)" @cancel="emit('cancel')" />
  </section>
</template>

<style scoped>
.invocation {
  display: grid; gap: var(--space-3); min-width: 0; max-height: 55dvh; overflow-y: auto; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow);
  animation: ui-rise-in var(--medium) var(--ease);
}
.head { display: flex; align-items: flex-start; gap: var(--space-3); }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
