<script setup lang="ts">
/**
 * The fields of a new Claude session: the machine it starts on (offered when there is more than one), the folder it
 * works in (the folders of the person's sessions offered as chips), what Claude should do, a title and the permission
 * mode. Problems show under their field.
 */
import type { SelectChoice } from '@harness/sdk';
import { computed } from 'vue';
import { usePageHost } from './host.ts';
import { folderName, MODE_CHOICES, type StartDraft } from './logic.ts';

const props = defineProps<{
  /** Folders to offer (where the person's sessions work). */
  folders: readonly string[];
  /** Machines to offer (where the person's sessions run); the choice shows when there is more than one. */
  machines: readonly string[];
  problems: Readonly<Record<string, string>>;
  disabled?: boolean;
}>();
const draft = defineModel<StartDraft>({ required: true });

const { Input, Select, Textarea } = usePageHost().components;
const MODES: readonly SelectChoice[] = [{ value: '', label: 'The machine\'s default' }, ...MODE_CHOICES];
const machineChoices = computed((): SelectChoice[] => [{ value: '', label: 'Any machine' }, ...props.machines.map((name) => ({ value: name, label: name }))]);
const offered = computed(() => props.folders.filter((folder) => folder !== draft.value.folder).slice(0, 6));
const set = <K extends keyof StartDraft>(key: K, value: StartDraft[K]): void => { draft.value = { ...draft.value, [key]: value }; };
</script>

<template>
  <div class="form" data-testid="claude-new-form">
    <Select
      v-if="machines.length > 1" :model-value="draft.machine" :options="machineChoices" label="Machine" :disabled="disabled"
      :error="problems['on'] ?? ''" data-testid="claude-machine" @update:model-value="set('machine', $event)"
    />
    <div class="folder">
      <Input
        :model-value="draft.folder" label="Folder" placeholder="C:/code/shop" icon="folder" :disabled="disabled"
        hint="Under one of the machine's folders." :error="problems['folder'] ?? ''" data-testid="claude-folder" @update:model-value="set('folder', $event)"
      />
      <div v-if="offered.length > 0" class="chips" aria-label="Folders you used">
        <button v-for="folder in offered" :key="folder" type="button" class="chip" :title="folder" :disabled="disabled" @click="set('folder', folder)">{{ folderName(folder) }}</button>
      </div>
    </div>
    <Textarea
      :model-value="draft.prompt" label="What should Claude do?" placeholder="Fix the failing checkout test and explain the cause." :rows="4" required :disabled="disabled"
      :error="problems['prompt'] ?? ''" data-testid="claude-prompt" @update:model-value="set('prompt', $event)"
    />
    <div class="pair">
      <Input :model-value="draft.title" label="Title" placeholder="From the folder when blank" :disabled="disabled" @update:model-value="set('title', $event)" />
      <Select :model-value="draft.mode" :options="MODES" label="Permission mode" :disabled="disabled" @update:model-value="set('mode', $event)" />
    </div>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); min-width: 0; }
.folder { display: grid; gap: var(--space-2); min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chip { padding: 2px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-dim); font: inherit; font-size: var(--text-xs); cursor: pointer; transition: border-color var(--fast, 120ms) var(--ease, ease), color var(--fast, 120ms) var(--ease, ease); }
.chip:hover { border-color: var(--border-strong); color: var(--text); }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); }
</style>
