<script setup lang="ts">
/**
 * Installing a system for the hub to keep and run: from a package, a folder or a git repository, and whether it
 * starts with the hub. The fields come from the install source schema, so a new kind of source shows up here.
 */
import type { InstallSource } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, UiSwitch, type SegmentOption } from '../../ui/index.ts';
import { INSTALL_KINDS, installFields, installSource, type InstallField, type InstallKind } from '../logic/forms.ts';

withDefaults(defineProps<{ busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ install: [source: InstallSource, autoStart: boolean] }>();

const KIND_LABEL = { package: 'Package', path: 'Folder', git: 'Git' } as const satisfies Record<InstallKind, string>;
const FIELD = {
  package: { label: 'Package', placeholder: '@harness/system-notes' },
  version: { label: 'Version', placeholder: '1.2.0' },
  path: { label: 'Folder', placeholder: '/opt/systems/notes' },
  git: { label: 'Repository', placeholder: 'https://github.com/acme/notes-system.git' },
  ref: { label: 'Branch, tag or commit', placeholder: 'main' },
} as const satisfies Record<InstallField, { label: string; placeholder: string }>;

const kind = ref<InstallKind>('package');
const fields = ref<Partial<Record<InstallField, string>>>({});
const autoStart = ref(true);
const tried = ref(false);
const kinds = INSTALL_KINDS.map((k): SegmentOption<InstallKind> => ({ value: k, label: KIND_LABEL[k] }));
const shown = computed(() => installFields(kind.value));
const checked = computed(() => installSource({ kind: kind.value, fields: fields.value }));
const errorOf = (field: InstallField): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');

watch(open, (isOpen) => { if (isOpen) { fields.value = {}; tried.value = false; } });

function set(field: InstallField, value: string): void {
  fields.value = { ...fields.value, [field]: value };
}

function install(): void {
  tried.value = true;
  if (checked.value.ok) { emit('install', checked.value.value, autoStart.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Install a system" description="The hub keeps it on disk, pairs it and starts it." width="520px">
    <form class="form" novalidate data-testid="install-form" @submit.prevent="install">
      <UiSegmented v-model="kind" :options="kinds" label="From" />
      <div class="fields">
        <UiInput
          v-for="field in shown" :key="`${kind}-${field}`" :model-value="fields[field] ?? ''" :label="FIELD[field].label" :placeholder="FIELD[field].placeholder"
          :error="errorOf(field)" required @update:model-value="set(field, $event)"
        />
      </div>
      <UiSwitch v-model="autoStart" label="Start with the hub" description="Restarted if it crashes." />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" icon="plus" :loading="busy" data-testid="install-submit" @click="install">Install</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.fields { display: grid; gap: var(--space-3); }
</style>
