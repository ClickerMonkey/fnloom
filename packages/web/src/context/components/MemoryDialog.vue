<script setup lang="ts">
/**
 * Writing a memory, or changing one: a short title (its name comes from it), what to remember, who it is for (only its
 * author, or everyone; fixed once written), and, folded under Advanced, every other context option: the fns tied to
 * it, the fns suggested with it, the agents that always carry it, a `/command`, its parent, tags, a summary, its weight
 * and who sees and is suggested it. Opened on a memory it starts from that memory. Save sends the draft; a problem
 * shows once Save is pressed.
 */
import { Audience, QualifiedName, type ContextRecord } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiIcon, UiInput, UiSegmented, UiSelect, UiTextarea, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import {
  AUDIENCE_WORDS, changedOptions, memoryDraft, memoryRequest, optionsRequest, PLAIN_OPTIONS, type BrowserScope, type ContextOptionsDraft, type MemoryDraft,
} from '../logic/context.ts';
import NameListInput from './NameListInput.vue';

const props = withDefaults(defineProps<{
  /** The memory being changed; a new one when absent. */
  memory?: Pick<ContextRecord, 'origin' | 'decl'> | undefined;
  busy?: boolean;
  problem?: string;
  /** Fn names matching what is typed, for the fn fields. */
  suggestFns?: ((prefix: string) => Promise<readonly string[]>) | undefined;
}>(), { memory: undefined, busy: false, problem: '', suggestFns: undefined });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [draft: MemoryDraft] }>();

const SCOPES: readonly SegmentOption<BrowserScope>[] = [{ value: 'user', label: 'Only me', icon: 'user' }, { value: 'everyone', label: 'Everyone', icon: 'users' }];
const AUDIENCES: readonly SelectOption<Audience>[] = Audience.options.map((value) => ({ value, label: AUDIENCE_WORDS[value] }));
const readFn = (text: string): QualifiedName | undefined => { const parsed = QualifiedName.safeParse(text); return parsed.success ? parsed.data : undefined; };
const readTag = (text: string): string | undefined => (text === '' ? undefined : text);
const FN_REFUSAL = 'A fn’s full name, like fs/read.';

const title = ref('');
const text = ref('');
const scope = ref<BrowserScope>('user');
const options = ref<ContextOptionsDraft>(PLAIN_OPTIONS);
const advanced = ref(false);
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  const start = memoryDraft(props.memory);
  title.value = start.title; text.value = start.text; scope.value = start.scope; options.value = start.options;
  advanced.value = false;
  tried.value = false;
}, { immediate: true });

const draft = computed((): MemoryDraft => ({ title: title.value, text: text.value, scope: scope.value, options: options.value }));
const checked = computed(() => memoryRequest(draft.value));
const optionsProblem = computed(() => { const read = optionsRequest(options.value, false); return read.ok ? '' : read.problem; });
const textError = computed(() => (tried.value && !checked.value.ok && optionsProblem.value === '' ? checked.value.problem : ''));
const changed = computed(() => changedOptions(options.value));
const editing = computed(() => props.memory !== undefined);
const weight = computed({ get: () => String(options.value.weight), set: (typedWeight) => { const n = Number(typedWeight); if (Number.isFinite(n)) { set('weight', Math.min(2, Math.max(0, n))); } } });

function set<K extends keyof ContextOptionsDraft>(key: K, value: ContextOptionsDraft[K]): void {
  options.value = { ...options.value, [key]: value };
}
function save(): void {
  tried.value = true;
  if (optionsProblem.value !== '') { advanced.value = true; }
  if (checked.value.ok) { emit('save', draft.value); }
}
</script>

<template>
  <UiDialog
    v-model:open="open" :title="editing ? 'Edit this memory' : 'New context'" width="600px"
    :description="editing ? 'Changes it in place; who it is for stays as written.' : 'Context the agent can be given when a message is about it.'"
  >
    <form class="form" data-testid="memory-form" @submit.prevent="save">
      <div class="top">
        <UiInput v-model="title" class="title" label="Title" placeholder="Prefers tabs" hint="Optional: the first words are used when blank." autofocus data-testid="memory-title" />
        <div v-if="!editing" class="field">
          <span class="label">Who it is for</span>
          <UiSegmented v-model="scope" :options="SCOPES" label="Who it is for" data-testid="memory-scope" />
        </div>
      </div>
      <UiTextarea v-model="text" label="Context" :rows="4" :error="textError" placeholder="The owner indents with tabs, never spaces." data-testid="memory-text" />

      <button type="button" class="fold" :aria-expanded="advanced" data-testid="memory-advanced" @click="advanced = !advanced">
        <UiIcon :name="advanced ? 'chevron-down' : 'chevron-right'" :size="14" />
        Advanced
        <span class="dim">{{ changed === 0 ? 'fns, command, weight and more' : `${changed} changed` }}</span>
      </button>
      <div v-if="advanced" class="advanced" data-testid="memory-options">
        <NameListInput
          :model-value="options.fns" label="Tied fns" hint="Offered whenever this is loaded." placeholder="fs/read" :read="readFn" :refusal="FN_REFUSAL" :suggest="suggestFns"
          testid="memory-fns" @update:model-value="set('fns', $event)"
        />
        <NameListInput
          :model-value="options.suggestFns" label="Suggested fns" hint="Suggested alongside it." placeholder="fs/search" :read="readFn" :refusal="FN_REFUSAL" :suggest="suggestFns"
          @update:model-value="set('suggestFns', $event)"
        />
        <NameListInput
          :model-value="options.alwaysFor" label="Always for" hint="Agent fns whose prompts always carry it." placeholder="hub/chat" :read="readFn" :refusal="FN_REFUSAL" :suggest="suggestFns"
          @update:model-value="set('alwaysFor', $event)"
        />
        <NameListInput :model-value="options.tags" label="Tags" placeholder="style" :read="readTag" @update:model-value="set('tags', $event)" />
        <UiInput :model-value="options.command" label="Command" placeholder="/tabs" hint="Loads it from the composer." data-testid="memory-command" @update:model-value="set('command', $event)" />
        <UiInput :model-value="options.parent" label="Parent" placeholder="fs/guide" hint="Its place in a hierarchy." @update:model-value="set('parent', $event)" />
        <UiInput v-model="weight" type="number" label="Weight" hint="0 leaves it out, 1 is plain, up to 2." />
        <UiInput :model-value="options.summary" label="Summary" placeholder="The title" hint="The short form agents see first." @update:model-value="set('summary', $event)" />
        <UiSelect :model-value="options.visible" :options="AUDIENCES" label="Listed for" @update:model-value="set('visible', $event)" />
        <UiSelect :model-value="options.suggest" :options="AUDIENCES" label="Suggested to" @update:model-value="set('suggest', $event)" />
      </div>
      <UiBanner v-if="tried && optionsProblem !== ''" tone="danger" icon="warning">{{ optionsProblem }}</UiBanner>
      <UiBanner v-if="problem !== ''" tone="danger" icon="warning">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" icon="check" :loading="busy" data-testid="memory-save" @click="save">{{ editing ? 'Save' : 'Add' }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); }
.top { display: flex; flex-wrap: wrap; align-items: start; gap: var(--space-3); }
.title { flex: 1 1 16rem; min-width: 0; }
.field { display: grid; gap: var(--space-1); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.fold {
  display: inline-flex; align-items: center; gap: var(--space-1); justify-self: start; padding: 2px 4px; margin-left: -4px; border: 0; border-radius: 6px;
  background: none; color: var(--text); font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer;
}
.fold:hover { background: var(--surface-2); }
.dim { color: var(--text-faint); font-weight: var(--weight-normal, 400); }
.advanced { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: var(--space-3); }
</style>
