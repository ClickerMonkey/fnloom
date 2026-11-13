<script setup lang="ts">
/**
 * The fields of a new Claude session: the machine it starts on (offered when there is more than one), the folder it
 * works in (the folders of the person's sessions offered as chips), what Claude should do, a title and the permission
 * mode. Problems show under their field.
 */
import type { ClaudePermissionMode } from '@harness/core';
import { computed } from 'vue';
import { UiInput, UiSelect, UiTextarea, type SelectOption } from '../../ui/index.ts';
import { MODE_OPTIONS, folderName, type StartDraft } from '../logic/claude.ts';

const props = defineProps<{
  /** Folders to offer (where the person's sessions work). */
  folders: readonly string[];
  /** Machines to offer (where the person's sessions run); the choice shows when there is more than one. */
  machines: readonly string[];
  problems: Readonly<Record<string, string>>;
  disabled?: boolean;
}>();
const draft = defineModel<StartDraft>({ required: true });

const MODES: readonly SelectOption<ClaudePermissionMode | ''>[] = [{ value: '', label: 'The machine\'s default' }, ...MODE_OPTIONS];
const machineOptions = computed((): SelectOption<string>[] => [{ value: '', label: 'Any machine' }, ...props.machines.map((name) => ({ value: name, label: name }))]);
const offered = computed(() => props.folders.filter((folder) => folder !== draft.value.folder).slice(0, 6));
const set = <K extends keyof StartDraft>(key: K, value: StartDraft[K]): void => { draft.value = { ...draft.value, [key]: value }; };
</script>

<template>
  <div class="form" data-testid="claude-new-form">
    <UiSelect
      v-if="machines.length > 1" :model-value="draft.machine" :options="machineOptions" label="Machine" :disabled="disabled"
      :error="problems['on'] ?? ''" data-testid="claude-machine" @update:model-value="set('machine', $event)"
    />
    <div class="folder">
      <UiInput
        :model-value="draft.folder" label="Folder" placeholder="C:/code/shop" icon="folder" required :disabled="disabled"
        hint="Under one of the machine's folders." :error="problems['folder'] ?? ''" data-testid="claude-folder" @update:model-value="set('folder', $event)"
      />
      <div v-if="offered.length > 0" class="chips" aria-label="Folders you used">
        <button v-for="folder in offered" :key="folder" type="button" class="chip" :title="folder" :disabled="disabled" @click="set('folder', folder)">{{ folderName(folder) }}</button>
      </div>
    </div>
    <UiTextarea
      :model-value="draft.prompt" label="What should Claude do?" placeholder="Fix the failing checkout test and explain the cause." :rows="4" required :disabled="disabled"
      :error="problems['prompt'] ?? ''" data-testid="claude-prompt" @update:model-value="set('prompt', $event)"
    />
    <div class="pair">
      <UiInput :model-value="draft.title" label="Title" placeholder="From the folder when blank" :disabled="disabled" @update:model-value="set('title', $event)" />
      <UiSelect :model-value="draft.mode" :options="MODES" label="Permission mode" :disabled="disabled" @update:model-value="set('mode', $event)" />
    </div>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); min-width: 0; }
.folder { display: grid; gap: var(--space-2); min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.chip { padding: 2px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-dim); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.chip:hover { border-color: var(--border-strong); color: var(--text); }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); }
</style>
