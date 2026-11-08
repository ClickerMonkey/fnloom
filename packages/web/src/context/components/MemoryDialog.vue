<script setup lang="ts">
/**
 * Writing a memory, or changing one: a short title (its name comes from it), what to remember, and who it is for (only
 * its author, or everyone). Opened on a memory it starts from that memory's words. Save sends the draft; an empty text
 * is the one problem, shown once Save is pressed.
 */
import type { ContextRecord } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, UiTextarea, type SegmentOption } from '../../ui/index.ts';
import { memoryDraft, memoryRequest, type BrowserScope, type MemoryDraft } from '../logic/context.ts';

const props = withDefaults(defineProps<{
  /** The memory being changed; a new one when absent. */
  memory?: Pick<ContextRecord, 'origin' | 'decl'> | undefined;
  busy?: boolean;
  problem?: string;
}>(), { memory: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [draft: MemoryDraft] }>();

const SCOPES: readonly SegmentOption<BrowserScope>[] = [{ value: 'user', label: 'Only me', icon: 'user' }, { value: 'everyone', label: 'Everyone', icon: 'users' }];

const title = ref('');
const text = ref('');
const scope = ref<BrowserScope>('user');
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  const start = memoryDraft(props.memory);
  title.value = start.title; text.value = start.text; scope.value = start.scope;
  tried.value = false;
}, { immediate: true });

const draft = computed((): MemoryDraft => ({ title: title.value, text: text.value, scope: scope.value }));
const checked = computed(() => memoryRequest(draft.value));
const textError = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));
const editing = computed(() => props.memory !== undefined);

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', draft.value); }
}
</script>

<template>
  <UiDialog
    v-model:open="open" :title="editing ? 'Edit this memory' : 'Remember something'" width="540px"
    :description="editing ? 'Saving writes the memory anew and forgets this one.' : 'A memory is context the agent can be given when a message is about it.'"
  >
    <form class="form" data-testid="memory-form" @submit.prevent="save">
      <UiInput v-model="title" label="Title" placeholder="Prefers tabs" hint="Optional: the first words are used when blank." autofocus data-testid="memory-title" />
      <UiTextarea v-model="text" label="What to remember" :rows="5" :error="textError" placeholder="The owner indents with tabs, never spaces." data-testid="memory-text" />
      <div class="field">
        <span class="label">Who it is for</span>
        <UiSegmented v-model="scope" :options="SCOPES" label="Who it is for" data-testid="memory-scope" />
      </div>
      <UiBanner v-if="problem !== ''" tone="danger" icon="warning">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" icon="check" :loading="busy" data-testid="memory-save" @click="save">{{ editing ? 'Save' : 'Remember' }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
</style>
