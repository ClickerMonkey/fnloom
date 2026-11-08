<script setup lang="ts">
/**
 * Choosing a system package zip: drop it on the zone or choose it, then name the instance it becomes (blank lets the
 * hub choose), optionally a data export to restore into it, and see the upload's progress. Says plainly that a package
 * is code that runs as the hub's user.
 */
import { ref } from 'vue';
import { formatBytes } from '../../chat/logic/format.ts';
import { UiBanner, UiButton, UiIcon, UiInput } from '../../ui/index.ts';
import { isPackageFile } from '../state/packages.ts';

withDefaults(defineProps<{ busy?: boolean; progress?: number }>(), { busy: false, progress: 0 });
const zip = defineModel<File | undefined>('zip', { required: true });
const data = defineModel<File | undefined>('data', { required: true });
const instance = defineModel<string>('instance', { required: true });
const over = ref(false);
const problem = ref('');
const picker = ref<HTMLInputElement | null>(null);
const dataPicker = ref<HTMLInputElement | null>(null);

function take(files: FileList | null | undefined): void {
  const file = files?.[0];
  if (file === undefined) { return; }
  problem.value = isPackageFile(file) ? '' : `${file.name} isn’t a package zip.`;
  if (problem.value === '') { zip.value = file; }
}

function drop(event: DragEvent): void {
  over.value = false;
  take(event.dataTransfer?.files);
}

function chosen(event: Event, into: 'zip' | 'data'): void {
  if (!(event.target instanceof HTMLInputElement)) { return; }
  if (into === 'zip') { take(event.target.files); } else { data.value = event.target.files?.[0]; }
  event.target.value = '';
}
</script>

<template>
  <div class="package-drop">
    <div
      class="zone" :class="{ over, chosen: zip !== undefined }" data-testid="package-zone"
      @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="drop"
    >
      <UiIcon :name="zip ? 'file' : 'upload'" :size="22" />
      <template v-if="zip">
        <p class="name" data-testid="package-name">{{ zip.name }}</p>
        <p class="dim">{{ formatBytes(zip.size) }}</p>
        <div v-if="busy" class="bar" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${progress * 100}%` }" /></div>
      </template>
      <p v-else class="dim">Drop a package zip here (made by <code>harness system pack</code>)</p>
      <UiButton size="sm" :disabled="busy" data-testid="package-choose" @click="picker?.click()">{{ zip ? 'Choose another' : 'Choose a zip' }}</UiButton>
      <input ref="picker" class="hidden" type="file" accept=".zip,application/zip" data-testid="package-input" @change="chosen($event, 'zip')">
    </div>
    <p v-if="problem !== ''" class="problem" role="alert">{{ problem }}</p>
    <UiInput v-model="instance" label="Instance" placeholder="main" hint="Blank lets the hub choose. A name already installed adds another copy (a fleet)." data-testid="package-instance" />
    <div class="data">
      <span class="dim">{{ data ? `Restore ${data.name}` : 'Restore a data export (optional)' }}</span>
      <UiButton v-if="data" size="sm" variant="ghost" icon="x" @click="data = undefined">Remove</UiButton>
      <UiButton v-else size="sm" variant="ghost" icon="upload" :disabled="busy" @click="dataPicker?.click()">Choose</UiButton>
      <input ref="dataPicker" class="hidden" type="file" accept=".zip,application/zip" @change="chosen($event, 'data')">
    </div>
    <UiBanner tone="warn">A package is code. It runs on this computer as the hub’s user, with the hub’s access. Install only packages you trust.</UiBanner>
  </div>
</template>

<style scoped>
.package-drop { display: grid; gap: var(--space-3); min-width: 0; }
.zone {
  display: grid; justify-items: center; gap: var(--space-2); padding: var(--space-5) var(--space-4); border: 2px dashed var(--border-strong);
  border-radius: var(--radius-lg); background: var(--surface-2); color: var(--text-dim); text-align: center; transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease);
}
.zone.over { border-color: var(--accent); background: var(--accent-soft); }
.zone.chosen { border-style: solid; }
.name { margin: 0; color: var(--text); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.bar { width: min(100%, 240px); height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); transition: width var(--fast) var(--ease); }
.hidden { display: none; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.data { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
</style>
