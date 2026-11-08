<script setup lang="ts">
/**
 * Installing a system for the hub to keep and run: from a package zip (`harness system pack`, uploaded from here), an
 * npm package, a folder or a git repository, and whether it starts with the hub. The source fields come from the
 * install source schema, so a new kind of source shows up here.
 */
import type { InstallSource } from '@harness/core';
import type { PackageOptions } from '../state/packages.ts';
import PackageDrop from './PackageDrop.vue';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, UiSwitch, type SegmentOption } from '../../ui/index.ts';
import { INSTALL_KINDS, installFields, installSource, type InstallField, type InstallKind } from '../logic/forms.ts';

const props = withDefaults(defineProps<{
  busy?: boolean;
  problem?: string;
  /** How far a package zip's upload is (0 to 1). */
  progress?: number;
  /** What the dialog opens on. */
  from?: Choice;
}>(), { busy: false, problem: '', progress: 0, from: 'zip' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ install: [source: InstallSource, autoStart: boolean]; installZip: [zip: File, options: PackageOptions] }>();

/** A package zip is uploaded here, so it is a choice of its own beside the install sources typed in. */
type Choice = InstallKind | 'zip';
const KIND_LABEL = { zip: 'Zip', package: 'npm', path: 'Folder', git: 'Git' } as const satisfies Record<Choice, string>;
const FIELD = {
  package: { label: 'Package', placeholder: '@harness/system-notes' },
  version: { label: 'Version', placeholder: '1.2.0' },
  path: { label: 'Folder', placeholder: '/opt/systems/notes' },
  git: { label: 'Repository', placeholder: 'https://github.com/acme/notes-system.git' },
  ref: { label: 'Branch, tag or commit', placeholder: 'main' },
  zip: { label: 'Package zip', placeholder: '' },
  file: { label: 'File name', placeholder: 'notes-1.0.0.zip' },
} as const satisfies Record<InstallField, { label: string; placeholder: string }>;

const choice = ref<Choice>(props.from);
const kind = computed<InstallKind>(() => (choice.value === 'zip' ? 'package' : choice.value));
const zip = ref<File | undefined>(undefined);
const data = ref<File | undefined>(undefined);
const instance = ref('');
const zipProblem = ref('');
const fields = ref<Partial<Record<InstallField, string>>>({});
const autoStart = ref(true);
const tried = ref(false);
const kinds: SegmentOption<Choice>[] = [{ value: 'zip', label: KIND_LABEL.zip }, ...INSTALL_KINDS.map((k): SegmentOption<Choice> => ({ value: k, label: KIND_LABEL[k] }))];
const shown = computed(() => installFields(kind.value));
const checked = computed(() => installSource({ kind: kind.value, fields: fields.value }));
const errorOf = (field: InstallField): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');

watch(open, (isOpen) => {
  if (isOpen) { choice.value = props.from; fields.value = {}; tried.value = false; zip.value = undefined; data.value = undefined; instance.value = ''; zipProblem.value = ''; }
});

function set(field: InstallField, value: string): void {
  fields.value = { ...fields.value, [field]: value };
}

function install(): void {
  tried.value = true;
  if (choice.value === 'zip') {
    zipProblem.value = zip.value === undefined ? 'Choose a package zip.' : '';
    if (zip.value !== undefined) { emit('installZip', zip.value, { instance: instance.value, data: data.value, autoStart: autoStart.value }); }
    return;
  }
  if (checked.value.ok) { emit('install', checked.value.value, autoStart.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Install a system" description="The hub keeps it on disk, pairs it and starts it." width="520px">
    <form class="form" novalidate data-testid="install-form" @submit.prevent="install">
      <UiSegmented v-model="choice" :options="kinds" label="From" data-testid="install-from" />
      <template v-if="choice === 'zip'">
        <PackageDrop v-model:zip="zip" v-model:data="data" v-model:instance="instance" :busy="busy" :progress="progress" />
        <p v-if="zipProblem !== ''" class="problem" role="alert">{{ zipProblem }}</p>
      </template>
      <div v-else class="fields">
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
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
