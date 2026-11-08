<script setup lang="ts">
/**
 * A form that doesn't exist yet but could be made (a description, the text in an image, a transcript, a converted
 * table): what it is, the model that would make it and its estimated cost, and the button that makes it now.
 */
import type { FormOffer } from '@harness/core';
import { computed } from 'vue';
import { UiButton, UiEmpty } from '../../ui/index.ts';
import { FORM_LABEL } from '../logic/formats.ts';

const props = withDefaults(defineProps<{ offer: FormOffer; busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const emit = defineEmits<{ make: [] }>();

const label = computed(() => FORM_LABEL[props.offer.kind]);
const detail = computed(() => [
  props.offer.model === undefined ? '' : `with ${props.offer.model}`,
  props.offer.estimate === undefined ? '' : `about $${props.offer.estimate.toFixed(props.offer.estimate < 0.01 ? 4 : 2)}`,
].filter((s) => s !== '').join(', '));
</script>

<template>
  <div class="offer" data-testid="form-offer">
    <UiEmpty icon="sparkles" :title="`No ${label.toLowerCase()} yet`" :body="detail === '' ? 'The hub can make it now.' : `The hub can make it now, ${detail}.`" />
    <p v-if="problem !== ''" class="problem" role="alert">{{ problem }}</p>
    <UiButton variant="primary" icon="sparkles" :loading="busy" data-testid="form-make" @click="emit('make')">Make {{ label.toLowerCase() }}</UiButton>
  </div>
</template>

<style scoped>
.offer { display: grid; justify-items: center; gap: var(--space-3); padding: var(--space-4); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
