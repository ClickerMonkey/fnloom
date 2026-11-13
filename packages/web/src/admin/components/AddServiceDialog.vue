<script setup lang="ts">
/**
 * Adding a remote service to a fleet (an MCP server, an API service): its instance name (made from the label until
 * edited) above the service's own form (the default slot). The parent checks the draft and adds it.
 */
import { UiBanner, UiButton, UiDialog } from '../../ui/index.ts';
import InstanceNameField from './InstanceNameField.vue';

withDefaults(defineProps<{
  title: string;
  description: string;
  /** The label typed in the form, which the instance name follows. */
  label: string;
  nameHint: string;
  nameError?: string;
  busy?: boolean;
  problem?: string;
}>(), { nameError: '', busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const instance = defineModel<string>('instance', { required: true });
const emit = defineEmits<{ save: [] }>();
</script>

<template>
  <UiDialog v-model:open="open" :title="title" :description="description" width="620px">
    <form class="form" novalidate data-testid="add-service" @submit.prevent="emit('save')">
      <slot />
      <InstanceNameField v-model="instance" :label="label" :hint="nameHint" :error="nameError" />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
      <!-- Enter in a field submits the form; the visible button is in the footer, outside it -->
      <button type="submit" hidden />
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="add-service-save" @click="emit('save')">Add</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
</style>
