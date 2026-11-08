<script setup lang="ts">
/**
 * Adding resources to the hub: drop files (or choose them, or paste an image), or paste a web address to import the
 * page. Each file shows its progress until it is imported; the dialog stays open so more can be added.
 */
import { ref } from 'vue';
import { formatBytes } from '../../chat/logic/format.ts';
import { UiButton, UiDialog, UiIcon, UiIconButton, UiInput } from '../../ui/index.ts';
import type { Upload } from '../state/browser.ts';

defineProps<{ uploads: readonly Upload[]; importing: boolean; problem: string }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ files: [files: File[]]; url: [url: string]; dismiss: [id: number] }>();

const address = ref('');
const over = ref(false);
const picker = ref<HTMLInputElement | null>(null);

function dropped(event: DragEvent): void {
  over.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) { emit('files', files); }
}
function chosen(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) { return; }
  const files = [...(event.target.files ?? [])];
  if (files.length > 0) { emit('files', files); }
  event.target.value = '';
}
function pasted(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0) { event.preventDefault(); emit('files', files); }
}
function importUrl(): void {
  const url = address.value.trim();
  if (url === '') { return; }
  emit('url', url);
  address.value = '';
}
const STATUS = { uploading: 'Uploading', importing: 'Importing', done: 'Added', failed: 'Failed' } as const satisfies Record<Upload['status'], string>;
/** What an upload's line says: its problem, or where it is and its size. */
const stateOf = (upload: Upload): string => upload.problem ?? `${STATUS[upload.status]} · ${formatBytes(upload.size)}`;
</script>

<template>
  <UiDialog v-model:open="open" title="Add resources" description="Files and web pages you add are kept in the hub, converted for the agent, and searchable." width="560px">
    <div class="uploader" data-testid="uploader" @paste="pasted">
      <div
        class="drop" :class="{ over }" role="button" tabindex="0" aria-label="Choose files to add, or drop them here" data-testid="drop-zone"
        @click="picker?.click()" @keydown.enter.prevent="picker?.click()" @keydown.space.prevent="picker?.click()"
        @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="dropped"
      >
        <UiIcon name="upload" :size="28" />
        <span class="drop-title">Drop files here, or choose them</span>
        <span class="drop-hint">You can paste an image too.</span>
        <input ref="picker" class="picker" type="file" multiple tabindex="-1" aria-hidden="true" data-testid="file-input" @change="chosen" />
      </div>
      <form class="url" @submit.prevent="importUrl">
        <UiInput v-model="address" type="url" icon="globe" label="Or import a web page" placeholder="https://example.com/article" @enter="importUrl" />
        <UiButton type="submit" :loading="importing" :disabled="address.trim() === ''">Import</UiButton>
      </form>
      <p v-if="problem !== ''" class="problem" role="alert">{{ problem }}</p>
      <ul v-if="uploads.length > 0" class="uploads" aria-label="Uploads">
        <li v-for="upload in uploads" :key="upload.id" class="upload" :class="upload.status">
          <UiIcon :name="upload.status === 'done' ? 'check' : upload.status === 'failed' ? 'warning' : 'file'" :size="16" />
          <span class="name">{{ upload.name }}</span>
          <span class="state">{{ stateOf(upload) }}</span>
          <span class="bar" aria-hidden="true"><span :style="{ width: `${Math.round(upload.progress * 100)}%` }"></span></span>
          <UiIconButton icon="x" size="sm" :label="upload.status === 'uploading' ? `Stop ${upload.name}` : `Forget ${upload.name}`" @click="emit('dismiss', upload.id)" />
        </li>
      </ul>
    </div>
    <template #footer><UiButton variant="primary" @click="open = false">Done</UiButton></template>
  </UiDialog>
</template>

<style scoped>
.uploader { display: grid; gap: var(--space-4); }
.drop { position: relative; display: grid; justify-items: center; gap: var(--space-1); padding: var(--space-6) var(--space-4); border: 2px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-dim); text-align: center; cursor: pointer; }
.drop.over, .drop:hover { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 6%, transparent); }
.drop:focus-visible { outline: none; box-shadow: var(--ring); }
.drop-title { color: var(--text); font-weight: var(--weight-medium); }
.drop-hint { font-size: var(--text-xs); }
.picker { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.url { display: flex; align-items: flex-end; gap: var(--space-2); }
.url > :first-child { flex: 1; min-width: 0; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.uploads { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.upload { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 32px; grid-template-areas: 'icon name state x' 'icon bar bar x'; align-items: center; gap: 2px var(--space-2); font-size: var(--text-sm); }
.upload > :first-child { grid-area: icon; }
.name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { grid-area: state; color: var(--text-faint); font-size: var(--text-xs); }
.failed .state { color: var(--danger); }
.bar { grid-area: bar; height: 3px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); transition: width var(--fast) var(--ease); }
.done .bar > span { background: var(--ok); }
.upload > :last-child { grid-area: x; }
</style>
