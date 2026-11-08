<script setup lang="ts">
/**
 * Making context from a resource: its address, whether the items read the resource's current text when loaded
 * (`live`, never stale) or keep a copy (`snapshot`, marked stale when the resource changes), and an optional
 * `/command` that loads it. The hub makes one item for the resource and one per section, linked in order; making it
 * again updates the same items. Save sends the checked arguments.
 */
import type { ContextCopy, ContextFromResourceArgs } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { fromResourceRequest } from '../logic/context.ts';

const props = withDefaults(defineProps<{ uri?: string; busy?: boolean; problem?: string }>(), { uri: '', busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [args: ContextFromResourceArgs] }>();

const COPIES: readonly SegmentOption<ContextCopy>[] = [{ value: 'live', label: 'Live', icon: 'refresh' }, { value: 'snapshot', label: 'Snapshot', icon: 'copy' }];
const COPY_ABOUT = {
  live: 'Reads the resource’s current text whenever it is loaded, so it is never stale.',
  snapshot: 'Keeps a copy of the text now, marked stale when the resource changes.',
} as const satisfies Record<ContextCopy, string>;

const address = ref('');
const copyMode = ref<ContextCopy>('live');
const command = ref('');
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  address.value = props.uri; copyMode.value = 'live'; command.value = ''; tried.value = false;
}, { immediate: true });

const copyAbout = computed(() => COPY_ABOUT[copyMode.value]);
const checked = computed(() => fromResourceRequest({ uri: address.value, copy: copyMode.value, command: command.value }));
const error = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.args); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Make context from a resource" description="One item for the resource and one for each of its sections, linked in order." width="520px">
    <form class="form" data-testid="from-resource-form" @submit.prevent="save">
      <UiInput v-model="address" label="Resource address" placeholder="fs://work/README.md" :error="error" autofocus data-testid="from-resource-uri" />
      <div class="field">
        <span class="label">Text</span>
        <UiSegmented v-model="copyMode" :options="COPIES" label="Text" />
        <p class="hint">{{ copyAbout }}</p>
      </div>
      <UiInput v-model="command" label="Command" placeholder="readme" hint="Optional: typing /readme in a chat loads it." />
      <UiBanner v-if="problem !== ''" tone="danger" icon="warning">{{ problem }}</UiBanner>
      <button type="submit" hidden />
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" icon="sparkles" :loading="busy" data-testid="from-resource-save" @click="save">Make context</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
