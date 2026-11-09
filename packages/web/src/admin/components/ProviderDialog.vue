<script setup lang="ts">
/**
 * Adding or replacing a model provider. The fields are the provider's own (from the input schema); keys are typed
 * here, sent once over TLS, and never shown again. Amazon Bedrock signs in with an access key pair or a Bedrock API key.
 */
import { ProviderKind, type ProviderInput } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiField, UiInput, UiSegmented, UiSelect, type SelectOption } from '../../ui/index.ts';
import { AWS_AUTH, PROVIDER_NAME, providerBody, providerFields, type AwsAuthKind, type ProviderField, type ProviderKindInput } from '../logic/forms.ts';

const props = withDefaults(defineProps<{ busy?: boolean; problem?: string; kind?: ProviderKindInput }>(), { busy: false, problem: '', kind: 'openrouter' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [input: ProviderInput] }>();

const kind = ref<ProviderKindInput>(props.kind);
const fields = ref<Partial<Record<ProviderField, string>>>({});
const auth = ref<AwsAuthKind>('keys');
const tried = ref(false);
const kinds = ProviderKind.options.map((k): SelectOption<ProviderKindInput> => ({ value: k, label: PROVIDER_NAME[k] }));
const shown = computed(() => providerFields(kind.value, auth.value));
const checked = computed(() => providerBody(kind.value, fields.value, auth.value));
const errorOf = (field: ProviderField): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');

watch(open, (isOpen) => { if (isOpen) { kind.value = props.kind; auth.value = 'keys'; fields.value = {}; tried.value = false; } });

function set(field: ProviderField, value: string): void {
  fields.value = { ...fields.value, [field]: value };
}

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Add a provider" description="Its models become available to every agent." width="480px">
    <form class="form" novalidate data-testid="provider-form" @submit.prevent="save">
      <UiSelect v-model="kind" :options="kinds" label="Provider" />
      <UiField v-if="kind === 'aws'" label="Sign in with">
        <UiSegmented v-model="auth" :options="AWS_AUTH" label="Sign in with" data-testid="provider-aws-auth" />
      </UiField>
      <UiInput
        v-for="field in shown" :key="`${kind}-${auth}-${field.name}`" :model-value="fields[field.name] ?? ''" :label="field.label" :required="field.required"
        :hint="field.hint ?? ''" :placeholder="field.placeholder ?? ''"
        :type="field.secret ? 'password' : 'text'" :autocomplete="field.secret ? 'new-password' : 'off'" :error="errorOf(field.name)"
        @update:model-value="set(field.name, $event)"
      />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="provider-save" @click="save">Save provider</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
</style>
