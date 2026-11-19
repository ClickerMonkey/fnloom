<script setup lang="ts">
/**
 * An instance's facts (version, address, key, pairing, last sighting, config, manifest), on its own page and, for its
 * default instance, on its system's overview (a single-instance system shows its one instance there).
 */
import type { ActorId } from '@harness/core';
import { computed } from 'vue';
import { instanceFacts, type InstanceFactsSource } from '../logic/instances.ts';
import FactList from './FactList.vue';

const props = withDefaults(defineProps<{
  source: InstanceFactsSource;
  now: number;
  nameOf: (actor: ActorId) => string;
  /** Another system hosts it, and says where it runs: its address is left out. */
  hosted?: boolean;
  testid?: string;
}>(), { hosted: false, testid: 'instance-facts' });

const facts = computed(() => instanceFacts(props.source, props.now, props.nameOf, props.hosted));
</script>

<template>
  <FactList :facts="facts" :testid="testid" />
</template>
