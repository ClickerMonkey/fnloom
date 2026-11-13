<script setup lang="ts">
/**
 * An API service's settings (`ApiServiceConfig`): its label and description, the base URL every request is made
 * under, how it signs in, headers sent on every request, its OpenAPI document (the authoring agent reads its
 * operations), and its limits. The parent checks and saves the draft; problems come by config path.
 */
import { UiInput, UiTextarea } from '../../ui/index.ts';
import type { ApiServiceDraft } from '../logic/api-services.ts';
import type { PathProblems } from '../../state/problems.ts';
import { draftFields } from '../state/draft.ts';
import PairRowsEditor from './PairRowsEditor.vue';
import RemoteAuthFields from './RemoteAuthFields.vue';

withDefaults(defineProps<{ problems?: PathProblems }>(), { problems: () => ({}) });
const draft = defineModel<ApiServiceDraft>({ required: true });

const field = draftFields(draft);
const label = field('label');
const description = field('description');
const baseUrl = field('baseUrl');
const auth = field('auth');
const headers = field('headers');
const openapi = field('openapi');
const timeout = field('timeout');
const maxBody = field('maxBody');
</script>

<template>
  <div class="form" data-testid="api-service-form">
    <UiInput v-model="label" label="Name" placeholder="GitHub" required :error="problems['label'] ?? ''" data-testid="service-label" />
    <UiTextarea v-model="description" label="Description" :rows="2" placeholder="What it is for" />
    <UiInput
      v-model="baseUrl" label="Base URL" type="url" placeholder="https://api.github.com" required hint="Every request is made under it; a program can't leave it."
      :error="problems['baseUrl'] ?? ''" data-testid="service-base-url"
    />
    <RemoteAuthFields v-model="auth" :problems="problems" />
    <PairRowsEditor v-model:rows="headers" label="Headers on every request" name-placeholder="Accept" value-placeholder="application/json" hint="Not secrets; the sign-in carries those." :error="problems['headers'] ?? ''" testid="service-headers" />
    <UiInput v-model="openapi" label="OpenAPI document" type="url" placeholder="https://api.example.com/openapi.json" hint="The authoring agent reads its operations." :error="problems['openapi'] ?? ''" />
    <div class="pair">
      <UiInput v-model="timeout" label="Request timeout (seconds)" type="number" :error="problems['timeout'] ?? ''" />
      <UiInput v-model="maxBody" label="Largest body kept (KB)" type="number" hint="A larger response becomes a resource." :error="problems['maxBody'] ?? ''" />
    </div>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); min-width: 0; }
.pair { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); }
</style>
