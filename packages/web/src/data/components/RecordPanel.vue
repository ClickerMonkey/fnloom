<script setup lang="ts">
/**
 * One record of a stored type (build 8): its value drawn by the type (so a system's components draw its named types),
 * Edit (a form for the type, saved with the version it changes so two people editing at
 * once don't overwrite each other), Remove (asked first; its history stays), and its history, newest first (the first row
 * says who changed it last and when, by name), each version opening its value. With no record it is the form for a new one.
 */
import type { DataRecord, Json, RecordVersion } from '@harness/core';
import { ref, watch } from 'vue';
import GinForm from '../../gin/GinForm.vue';
import GinValueView from '../../gin/GinValueView.vue';
import type { NameOf } from '../../state/actor-names.ts';
import { UiButton, UiDialog, fullTime, relativeTime } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import { CHANGE_WORDS } from '../logic/data.ts';

const props = withDefaults(defineProps<{
  /** The type's gin definition (a reference to the stored type). */
  type: unknown;
  /** The record; absent for a new one. */
  record?: DataRecord | undefined;
  versions?: readonly RecordVersion[];
  moreVersions?: boolean;
  versionsLoading?: boolean;
  versionsProblem?: string;
  busy?: boolean;
  problem?: string;
  /** People's names for the actor ids in the history. */
  nameOf?: NameOf;
}>(), { nameOf: (actor: string) => actor, record: undefined, versions: () => [], moreVersions: false, versionsLoading: false, versionsProblem: '', busy: false, problem: '' });
const emit = defineEmits<{ save: [value: Json]; remove: []; more: []; cancel: [] }>();

const now = useNow();
const editing = ref(props.record === undefined);
const removing = ref(false);
const shown = ref<string | undefined>(undefined);
watch(() => props.record?.id, () => { editing.value = props.record === undefined; shown.value = undefined; });
watch(() => props.record?.version, () => { editing.value = props.record === undefined; });
</script>

<template>
  <div class="record" data-testid="record-panel" :data-record="record?.id">
    <p v-if="problem !== ''" class="problem" data-testid="record-problem">{{ problem }}</p>
    <template v-if="editing">
      <GinForm
        :type="type" :initial="record?.value" :submit-label="record === undefined ? 'Add' : 'Save'" :busy="busy"
        @submit="emit('save', $event)" @cancel="record === undefined ? emit('cancel') : (editing = false)"
      />
    </template>
    <template v-else-if="record">
      <GinValueView :type="type" :model-value="record.value" readonly label="Value" />
      <div class="ops">
        <UiButton size="sm" icon="edit" data-testid="record-edit" @click="editing = true">Edit</UiButton>
        <UiButton size="sm" variant="ghost" icon="trash" data-testid="record-remove" @click="removing = true">Remove</UiButton>
      </div>
      <section class="history" data-testid="record-history">
        <h3 class="heading">History</h3>
        <p v-if="versionsProblem !== ''" class="problem">{{ versionsProblem }}</p>
        <ol class="list">
          <li v-for="version in versions" :key="version.id">
            <button type="button" class="row" :aria-expanded="shown === version.id" data-testid="record-version" @click="shown = shown === version.id ? undefined : version.id">
              <span class="number">#{{ version.number }}</span>
              <span>{{ CHANGE_WORDS[version.change] }}</span>
              <span v-if="version.number === record.version" class="current">current</span>
              <span class="when">
                <template v-if="version.by">{{ nameOf(version.by) }}</template><template v-if="version.bySystem"> through {{ version.bySystem }}</template><template v-if="version.by || version.bySystem"> · </template>
                <time :datetime="new Date(version.at).toISOString()" :title="fullTime(version.at)">{{ relativeTime(version.at, now) }}</time>
              </span>
            </button>
            <GinValueView v-if="shown === version.id" class="value" :type="type" :model-value="version.value" readonly :label="`Version ${version.number}`" />
          </li>
        </ol>
        <UiButton v-if="moreVersions" size="sm" variant="ghost" :loading="versionsLoading" @click="emit('more')">Older versions</UiButton>
      </section>
      <UiDialog v-model:open="removing" title="Remove this record?" description="It goes from the list; its history stays." role="alertdialog" width="400px">
        <template #footer>
          <UiButton variant="ghost" @click="removing = false">Cancel</UiButton>
          <UiButton variant="danger" :loading="busy" data-testid="record-remove-confirm" @click="removing = false; emit('remove')">Remove</UiButton>
        </template>
      </UiDialog>
    </template>
  </div>
</template>

<style scoped>
.record { display: grid; gap: var(--space-3); min-width: 0; }
.ops { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.history { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); width: 100%; padding: var(--space-2) var(--space-3);
  border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer;
}
.row:hover { background: var(--surface-2); }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.number { font-family: var(--mono); color: var(--text-dim); }
.current { padding: 0 6px; border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); }
.when { margin-left: auto; color: var(--text-faint); font-size: var(--text-xs); }
.value { margin: 0 var(--space-3) var(--space-3); }
</style>
