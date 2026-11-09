<script setup lang="ts">
/**
 * A system's config, as a form made from its config type: each field checked as it is typed, the whole value
 * confirmed by gin before it is sent, and the hub's own problems (it checks again) listed if it refuses. Secret fields
 * are password inputs that read "Saved" while the hub keeps their value; leaving one alone keeps it.
 */
import type { Json } from '@harness/core';
import { UiBanner, UiCard, UiEmpty, fullTime, relativeTime } from '../../ui/index.ts';
import GinForm from '../../gin/GinForm.vue';

withDefaults(defineProps<{
  /** The system's config type (a gin type definition); absent when it declares none. */
  type: Json | undefined;
  value: Json | undefined;
  version?: number | undefined;
  setAt?: number | undefined;
  needsConfig: boolean;
  now: number;
  busy?: boolean;
  problems?: readonly string[];
  /** Dot paths of the config's secret fields. */
  secrets?: readonly string[];
}>(), { version: undefined, setAt: undefined, busy: false, problems: () => [], secrets: () => [] });
const emit = defineEmits<{ save: [value: Json] }>();
</script>

<template>
  <UiCard v-if="type === undefined" flat>
    <UiEmpty icon="settings" title="Nothing to configure" body="This system doesn't declare a config." />
  </UiCard>
  <UiCard v-else title="Config" :subtitle="version === undefined ? 'Not set yet' : `Version ${version}${setAt === undefined ? '' : `, set ${relativeTime(setAt, now)}`}`">
    <div class="config" :title="setAt === undefined ? undefined : fullTime(setAt)">
      <UiBanner v-if="needsConfig" tone="warn">It can't be used until it has a valid config.</UiBanner>
      <UiBanner v-if="problems.length > 0" tone="danger">
        <p class="lead">The hub refused this config:</p>
        <ul class="problems"><li v-for="problem in problems" :key="problem">{{ problem }}</li></ul>
      </UiBanner>
      <GinForm :key="version ?? 0" :type="type" :initial="value" submit-label="Save config" :busy="busy" :cancellable="false" :secrets="secrets" label="Config" @submit="emit('save', $event)" />
    </div>
  </UiCard>
</template>

<style scoped>
.config { display: grid; gap: var(--space-4); }
.lead { margin: 0; }
.problems { margin: var(--space-1) 0 0; padding-left: var(--space-5); }
</style>
