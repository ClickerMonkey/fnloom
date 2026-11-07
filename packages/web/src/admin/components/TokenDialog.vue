<script setup lang="ts">
/**
 * Making a one-time pairing token: optionally for one name, and for how long. Once made, the token shows once, with
 * a copy button; the hub keeps only its hash.
 */
import type { SystemName } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiCodeBlock, UiDialog, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { TOKEN_LIFETIMES, tokenBody } from '../logic/forms.ts';
import type { PairingToken } from '../state/systems.ts';
import { timeLeft } from '../logic/systems.ts';

const props = withDefaults(defineProps<{ busy?: boolean; problem?: string; token?: PairingToken | undefined; now: number }>(), { busy: false, problem: '', token: undefined });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ create: [name: SystemName | undefined, expiresIn: number] }>();

type Lifetime = (typeof TOKEN_LIFETIMES)[number]['label'];
const name = ref('');
const lifetime = ref<Lifetime>(TOKEN_LIFETIMES[1].label);
const tried = ref(false);
const options = TOKEN_LIFETIMES.map((l): SegmentOption<Lifetime> => ({ value: l.label, label: l.label }));
const expiresIn = computed(() => TOKEN_LIFETIMES.find((l) => l.label === lifetime.value)?.ms ?? TOKEN_LIFETIMES[1].ms);
const checked = computed(() => tokenBody(name.value, expiresIn.value));
const nameError = computed(() => (tried.value && !checked.value.ok ? checked.value.problems.name ?? '' : ''));

watch(open, (isOpen) => { if (isOpen) { name.value = ''; tried.value = false; } });

function create(): void {
  tried.value = true;
  if (checked.value.ok) { emit('create', checked.value.value.name, checked.value.value.expiresIn); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Pairing token" description="A system started with this token pairs without a code." width="480px">
    <div v-if="props.token" class="made" data-testid="token-made">
      <UiCodeBlock :code="props.token.token" language="text" filename="token" wrap />
      <p class="hint">It works once and lasts {{ timeLeft(props.token.expiresAt, now) }}. It won't be shown again.</p>
    </div>
    <form v-else class="form" novalidate @submit.prevent="create">
      <UiInput v-model="name" label="System name" hint="Leave empty to let any name use it." placeholder="notes" :error="nameError" autofocus />
      <div class="field">
        <span class="label">Lasts</span>
        <UiSegmented v-model="lifetime" :options="options" label="Lasts" />
      </div>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton v-if="props.token" variant="primary" @click="open = false">Done</UiButton>
      <template v-else>
        <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
        <UiButton variant="primary" icon="key" :loading="busy" data-testid="token-create" @click="create">Make token</UiButton>
      </template>
    </template>
  </UiDialog>
</template>

<style scoped>
.form, .made { display: grid; gap: var(--space-4); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
