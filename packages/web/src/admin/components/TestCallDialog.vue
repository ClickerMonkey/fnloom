<script setup lang="ts">
/**
 * A test call of one fn from a system's review: a form made from its args type (prefilled with its first example),
 * run as the admin and marked as a test. Once it starts, the dialog links to the run.
 */
import type { FnDecl, Json, RunId } from '@harness/core';
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import GinForm from '../../gin/GinForm.vue';
import { UiBanner, UiDialog, UiIcon } from '../../ui/index.ts';

const props = withDefaults(defineProps<{
  /** The fn being tried; the dialog is closed without one. */
  fn: FnDecl | undefined;
  /** Its qualified name, for the title. */
  title: string;
  busy?: boolean;
  problem?: string;
  /** The run the last test started. */
  run?: RunId | undefined;
  /** A run's page. */
  runPage: (run: RunId) => RouteLocationRaw;
}>(), { busy: false, problem: '', run: undefined });
const emit = defineEmits<{ call: [args: Json]; close: [] }>();

const open = computed({ get: () => props.fn !== undefined, set: (value) => { if (!value) { emit('close'); } } });
const initial = computed(() => props.fn?.examples?.[0]?.args);
</script>

<template>
  <UiDialog v-model:open="open" :title="`Test ${title}`" description="Runs it now as you, marked as a test. It works the same as a real call." width="560px">
    <div v-if="fn" class="body" data-testid="test-call">
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
      <RouterLink v-if="run !== undefined" :to="runPage(run)" class="run" data-testid="test-call-run"><UiIcon name="play" :size="14" />Open the test run</RouterLink>
      <GinForm :type="fn.args" :initial="initial" submit-label="Run test" :busy="busy" label="Args" @submit="emit('call', $event)" @cancel="emit('close')" />
    </div>
  </UiDialog>
</template>

<style scoped>
.body { display: grid; gap: var(--space-3); }
.run { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); }
</style>
