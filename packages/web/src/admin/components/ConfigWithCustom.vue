<script setup lang="ts">
/**
 * A system's config on its review, system and pairing pages: the gin form made from its config type, and, when its
 * contract names one (build 7), its own config component, drawn instead of the form (`replace`) or under it
 * (`beside`). Both save the same way; the hub checks the value with the gin type either way.
 */
import { isGinTypeDef, type Json } from '@harness/core';
import { computed } from 'vue';
import type { ConfigComponentRef, ConfigComponents } from '../state/config-component.ts';
import ConfigCustom from './ConfigCustom.vue';
import { UiBanner } from '../../ui/index.ts';
import SystemConfig from './SystemConfig.vue';

const props = withDefaults(defineProps<{
  type: Json | undefined;
  value: Json | undefined;
  version?: number | undefined;
  setAt?: number | undefined;
  needsConfig: boolean;
  now: number;
  busy?: boolean;
  problems?: readonly string[];
  secrets?: readonly string[];
  /** The system's own config component, when its contract names one. */
  target?: ConfigComponentRef | undefined;
  loader?: ConfigComponents | undefined;
}>(), { version: undefined, setAt: undefined, busy: false, problems: () => [], secrets: () => [], target: undefined, loader: undefined });
const emit = defineEmits<{ save: [value: Json] }>();

const ginType = computed(() => (isGinTypeDef(props.type) ? props.type : undefined));
const custom = computed(() => (props.target !== undefined && props.loader !== undefined && ginType.value !== undefined ? { target: props.target, loader: props.loader, type: ginType.value } : undefined));
// the form stands in for a system's own settings until its build is approved
const showForm = computed(() => custom.value === undefined || custom.value.target.decl.mode === 'beside' || !custom.value.target.approved);
</script>

<template>
  <div class="config">
    <SystemConfig
      v-if="showForm" :type="type" :value="value" :version="version" :set-at="setAt" :needs-config="needsConfig" :now="now" :busy="busy" :problems="problems" :secrets="secrets"
      @save="emit('save', $event)"
    />
    <UiBanner v-if="!showForm && problems.length > 0" tone="danger">
      <p class="lead">The hub refused this config:</p>
      <ul class="problems"><li v-for="problem in problems" :key="problem">{{ problem }}</li></ul>
    </UiBanner>
    <ConfigCustom v-if="custom" :target="custom.target" :loader="custom.loader" :type="custom.type" :value="value" :busy="busy" @save="emit('save', $event)" />
  </div>
</template>

<style scoped>
.config { display: grid; gap: var(--space-4); }
.lead { margin: 0; }
.problems { margin: var(--space-1) 0 0; padding-left: var(--space-5); }
</style>
