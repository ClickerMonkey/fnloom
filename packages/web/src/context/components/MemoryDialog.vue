<script setup lang="ts">
/**
 * Writing a memory, or changing one: a short title (its name comes from it), what to remember, who can see it (one
 * sharing choice: only me, me and chosen people, or everyone; asked only when writing one on a hub with more than one
 * person, and changed later on its page), and, folded under Advanced, every other context option: the fns tied to
 * it, the fns suggested with it, the agents that always carry it, a `/command`, its parent, tags, a summary, its weight
 * and whether people, agents or both see it listed and suggested. Opened on a memory it starts from that memory. Save sends the draft; a problem
 * shows once Save is pressed.
 */
import { Audience, QualifiedName, type ContextRecord, type ShareRule } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiChipInput, UiDialog, UiIcon, UiInput, UiSelect, UiTextarea, UiVisibility, onePicked, type SelectOption } from '../../ui/index.ts';
import {
  AUDIENCE_WORDS, changedOptions, memoryDraft, memoryRequest, ONLY_ME, optionsRequest, PLAIN_OPTIONS, type ContextOptionsDraft, type MemoryDraft,
} from '../logic/context.ts';
import HubPicker from '../../components/pickers/HubPicker.vue';
import { usePickerSources } from '../../components/pickers/sources.ts';

const props = withDefaults(defineProps<{
  /** The memory being changed; a new one when absent. */
  memory?: Pick<ContextRecord, 'origin' | 'decl'> | undefined;
  busy?: boolean;
  problem?: string;
  /** Whether the hub has more than one person; only then is who it is for asked. */
  multiUser?: boolean;
}>(), { memory: undefined, busy: false, problem: '', multiUser: false });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [draft: MemoryDraft] }>();

const people = usePickerSources().people();
const AUDIENCES: readonly SelectOption<Audience>[] = Audience.options.map((value) => ({ value, label: AUDIENCE_WORDS[value] }));
/** The picked fns as full names (a picker only offers full names; anything else is left out). */
const fnNames = (values: readonly string[]): QualifiedName[] => values.flatMap((value) => { const parsed = QualifiedName.safeParse(value); return parsed.success ? [parsed.data] : []; });
const readTag = (text: string): string | undefined => (text === '' ? undefined : text);

const title = ref('');
const text = ref('');
const share = ref<ShareRule>(ONLY_ME);
const options = ref<ContextOptionsDraft>(PLAIN_OPTIONS);
const advanced = ref(false);
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  const start = memoryDraft(props.memory);
  title.value = start.title; text.value = start.text; share.value = start.share; options.value = start.options;
  advanced.value = false;
  tried.value = false;
}, { immediate: true });

const draft = computed((): MemoryDraft => ({ title: title.value, text: text.value, share: share.value, options: options.value }));
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
    :description="editing ? (multiUser ? 'Changes it in place; who can see it is changed on its page.' : 'Changes it in place.') : 'Context the agent can be given when a message is about it.'"
  >
    <form class="form" data-testid="memory-form" @submit.prevent="save">
      <UiInput v-model="title" label="Title" placeholder="Prefers tabs" hint="Optional: the first words are used when blank." autofocus data-testid="memory-title" />
      <UiVisibility v-if="!editing && multiUser" v-model="share" :people="people" label="Who can see it" data-testid="memory-scope" />
      <UiTextarea v-model="text" label="Context" :rows="4" :error="textError" placeholder="The owner indents with tabs, never spaces." data-testid="memory-text" />

      <button type="button" class="fold" :aria-expanded="advanced" data-testid="memory-advanced" @click="advanced = !advanced">
        <UiIcon :name="advanced ? 'chevron-down' : 'chevron-right'" :size="14" />
        Advanced
        <span class="dim">{{ changed === 0 ? 'fns, command, weight and more' : `${changed} changed` }}</span>
      </button>
      <div v-if="advanced" class="advanced" data-testid="memory-options">
        <HubPicker
          :model-value="options.fns" source="fn" label="Tied fns" hint="Offered whenever this is loaded." placeholder="Search fns" testid="memory-fns"
          @update:model-value="set('fns', fnNames($event))"
        />
        <HubPicker :model-value="options.suggestFns" source="fn" label="Suggested fns" hint="Suggested alongside it." placeholder="Search fns" @update:model-value="set('suggestFns', fnNames($event))" />
        <HubPicker
          :model-value="options.inject.into" source="fn" label="Inject into" hint="Agents whose system prompts carry it (admins only)." placeholder="Search agent fns"
          testid="memory-inject" @update:model-value="set('inject', { ...options.inject, into: fnNames($event) })"
        />
        <UiChipInput :model-value="options.tags" label="Tags" placeholder="style" :read="readTag" @update:model-value="set('tags', $event)" />
        <UiInput :model-value="options.command" label="Command" placeholder="/tabs" hint="Loads it from the composer." data-testid="memory-command" @update:model-value="set('command', $event)" />
        <HubPicker
          :model-value="onePicked(options.parent)" source="context" :max="1" label="Parent" placeholder="Search context" hint="Its place in a hierarchy."
          testid="memory-parent" @update:model-value="set('parent', $event[0] ?? '')"
        />
        <UiInput v-model="weight" type="number" label="Weight" hint="0 leaves it out, 1 is plain, up to 2." />
        <UiInput :model-value="options.summary" label="Summary" placeholder="The title" hint="The short form agents see first." @update:model-value="set('summary', $event)" />
        <UiSelect :model-value="options.visible" :options="AUDIENCES" label="Listed for" hint="People, agents, both or neither." @update:model-value="set('visible', $event)" />
        <UiSelect :model-value="options.suggest" :options="AUDIENCES" label="Suggested to" hint="People, agents, both or neither." @update:model-value="set('suggest', $event)" />
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
.fold {
  display: inline-flex; align-items: center; gap: var(--space-1); justify-self: start; padding: 2px 4px; margin-left: -4px; border: 0; border-radius: 6px;
  background: none; color: var(--text); font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer;
}
.fold:hover { background: var(--surface-2); }
.dim { color: var(--text-faint); font-weight: var(--weight-normal, 400); }
.advanced { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: var(--space-3); }
</style>
