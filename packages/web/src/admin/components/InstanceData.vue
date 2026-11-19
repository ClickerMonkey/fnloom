<script setup lang="ts">
/**
 * An instance's data: the folders the hub gives it (outside the package, so upgrades and rollbacks keep them) and an
 * export of its data folder as a zip, its config's secrets only when asked. On an instance's page, and on its system's
 * page when the system runs one instance.
 */
import type { InstanceDirs } from '@harness/core';
import { ref } from 'vue';
import { formatBytes } from '../../chat/logic/format.ts';
import { UiBanner, UiButton, UiCard, UiIcon, UiSwitch } from '../../ui/index.ts';

defineProps<{
  /** Its folders, when the hub runs it; absent when it runs elsewhere. */
  dirs: InstanceDirs | undefined;
  busy: boolean;
  /** The last export's download, once made. */
  exported: { readonly url: string; readonly size: number } | undefined;
}>();
const emit = defineEmits<{ export: [withSecrets: boolean] }>();
const withSecrets = ref(false);
</script>

<template>
  <div class="data" data-testid="instance-data">
    <UiCard title="Folders" subtitle="The hub keeps these outside the package, so upgrades and rollbacks keep them.">
      <dl v-if="dirs" class="facts">
        <div><dt>Data</dt><dd><code>{{ dirs.data }}</code></dd></div>
        <div><dt>State</dt><dd><code>{{ dirs.state }}</code></dd></div>
        <div><dt>Cache</dt><dd><code>{{ dirs.cache }}</code> <span class="dim">(never exported)</span></dd></div>
      </dl>
      <p v-else class="dim">It runs elsewhere, so it keeps its own folders on its machine.</p>
    </UiCard>
    <UiCard title="Export its data" subtitle="A zip of its data folder and config, which harness system install --data restores.">
      <div class="export">
        <UiSwitch v-model="withSecrets" label="Include the config's secrets" description="Anyone with the zip can read them." data-testid="export-secrets" />
        <UiBanner v-if="withSecrets" tone="warn">The zip will hold its secrets in plain text.</UiBanner>
        <div class="row">
          <UiButton icon="download" :loading="busy" data-testid="export-data" @click="emit('export', withSecrets)">Export</UiButton>
          <a v-if="exported" class="download" :href="exported.url" download data-testid="export-download"><UiIcon name="download" :size="14" />Download ({{ formatBytes(exported.size) }})</a>
        </div>
      </div>
    </UiCard>
  </div>
</template>

<style scoped>
.data { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; gap: var(--space-4); }
.facts { display: grid; gap: var(--space-3); margin: 0; }
.facts > div { display: grid; grid-template-columns: minmax(96px, 30%) minmax(0, 1fr); gap: var(--space-3); }
dt { color: var(--text-dim); font-size: var(--text-sm); }
dd { margin: 0; overflow-wrap: anywhere; font-size: var(--text-sm); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.export { display: grid; gap: var(--space-3); }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.download { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); }
</style>
