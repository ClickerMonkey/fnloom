<script setup lang="ts">
/**
 * The auto pair choice at pairing: off, or on with how long the secret lasts. On, the hub gives the instance a secret
 * of its own so it can pair again by itself (its key lost, or the hub forgot it) until the secret ends or is revoked.
 * `undefined` is off.
 */
import type { AutoPairChoice } from '@harness/core';
import { computed } from 'vue';
import { UiSegmented, UiSwitch, type SegmentOption } from '../../ui/index.ts';
import { AUTO_PAIR_LIFETIMES } from '../logic/forms.ts';

const choice = defineModel<AutoPairChoice | undefined>({ required: true });

type Lifetime = (typeof AUTO_PAIR_LIFETIMES)[number]['label'];
const OPTIONS = AUTO_PAIR_LIFETIMES.map((l): SegmentOption<Lifetime> => ({ value: l.label, label: l.label }));
const on = computed({ get: () => choice.value !== undefined, set: (isOn) => { choice.value = isOn ? { expiresIn: AUTO_PAIR_LIFETIMES[0].ms } : undefined; } });
const lifetime = computed<Lifetime>({
  get: () => AUTO_PAIR_LIFETIMES.find((l) => l.ms === choice.value?.expiresIn)?.label ?? AUTO_PAIR_LIFETIMES[0].label,
  set: (label) => { choice.value = { expiresIn: AUTO_PAIR_LIFETIMES.find((l) => l.label === label)?.ms ?? AUTO_PAIR_LIFETIMES[0].ms }; },
});
</script>

<template>
  <div class="auto-pair" data-testid="auto-pair">
    <UiSwitch v-model="on" label="Auto pair" description="It can pair again by itself if its key is lost, until the secret ends or you revoke it." />
    <UiSegmented v-if="on" v-model="lifetime" :options="OPTIONS" label="Auto pair lasts" data-testid="auto-pair-lifetime" />
  </div>
</template>

<style scoped>
.auto-pair { display: grid; gap: var(--space-2); min-width: 0; }
</style>
