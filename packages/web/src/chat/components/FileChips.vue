<script setup lang="ts">
/**
 * Files staged in the composer: name, size, a ring that fills as the upload goes (a thumbnail for images), and
 * remove. A failed upload says so and offers Retry.
 */
import { UiIcon, UiIconButton } from '../../ui/index.ts';
import { formatBytes } from '../logic/format.ts';
import type { StagedFile } from '../state/uploads.ts';

defineProps<{ files: readonly StagedFile[] }>();
const emit = defineEmits<{ remove: [id: number]; retry: [id: number] }>();

const RING = 2 * Math.PI * 9;
</script>

<template>
  <ul class="files" data-testid="staged-files">
    <li v-for="file in files" :key="file.id" class="file" :class="file.status" :data-status="file.status">
      <span class="thumb">
        <img v-if="file.preview" :src="file.preview" alt="" width="28" height="28" />
        <UiIcon v-else :name="file.status === 'failed' ? 'warning' : 'file'" :size="14" />
        <svg v-if="file.status === 'uploading'" class="ring" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="9" class="track" />
          <circle cx="11" cy="11" r="9" class="bar" :stroke-dasharray="RING" :stroke-dashoffset="RING * (1 - file.progress)" />
        </svg>
      </span>
      <span class="text">
        <span class="name" :title="file.name">{{ file.name }}</span>
        <span class="size">{{ file.status === 'failed' ? (file.problem ?? 'Upload failed') : file.status === 'uploading' ? `${Math.round(file.progress * 100)}%` : formatBytes(file.size) }}</span>
      </span>
      <UiIconButton v-if="file.status === 'failed'" size="sm" icon="refresh" :label="`Retry ${file.name}`" @click="emit('retry', file.id)" />
      <UiIconButton size="sm" icon="x" :label="`Remove ${file.name}`" @click="emit('remove', file.id)" />
    </li>
  </ul>
</template>

<style scoped>
.files { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.file { display: flex; align-items: center; gap: var(--space-2); max-width: 240px; min-width: 0; padding: 4px 2px 4px 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); animation: ui-pop-in var(--fast) var(--ease); }
.file.failed { border-color: var(--danger-soft); }
.thumb { position: relative; display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: var(--radius-sm); background: var(--surface-3); color: var(--text-dim); overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.ring { position: absolute; inset: 3px; transform: rotate(-90deg); }
.track { fill: none; stroke: var(--border-strong); stroke-width: 2.5; }
.bar { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linecap: round; transition: stroke-dashoffset var(--medium) var(--ease); }
.text { display: grid; flex: 1; min-width: 0; line-height: 1.25; }
.name { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.failed .size { color: var(--danger); }
</style>
