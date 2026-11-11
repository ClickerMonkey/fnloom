<script setup lang="ts">
/**
 * What an install approval binds (`InstallSubject`): the system and version it starts (and the one it replaces), the
 * instance that hosts it, and the hashes the hub checks again when the approved run asks for its pairing grant. Hashes
 * show shortened, the whole value in the tooltip and copied with a press.
 */
import type { InstallSubject } from '@harness/core';
import { computed } from 'vue';
import { copyText, shortHash, UiIconButton } from '../../ui/index.ts';

const props = defineProps<{ subject: InstallSubject }>();

const hashes = computed(() => [
  { label: 'Bundle', value: props.subject.bundleHash, about: 'sha-256 of the one file that will run' },
  { label: 'Folder', value: props.subject.sourceHash, about: 'sha-256 of the folder it was built from; a change after approval stops it' },
  { label: 'Contract', value: props.subject.manifestHash, about: 'the hash of the fns, types and hooks it declares' },
]);
</script>

<template>
  <dl class="subject" data-testid="install-subject">
    <div class="row">
      <dt>Starts</dt>
      <dd>
        <strong>{{ subject.system }}</strong><span v-if="subject.instance !== 'main'">@{{ subject.instance }}</span> {{ subject.version }}
        <span v-if="subject.replaces" class="dim" data-testid="install-replaces">, replacing {{ subject.replaces.version }}</span>
      </dd>
    </div>
    <div class="row">
      <dt>Hosted by</dt>
      <dd>{{ subject.host.system }}/{{ subject.host.instance }}</dd>
    </div>
    <div v-for="hash in hashes" :key="hash.label" class="row">
      <dt :title="hash.about">{{ hash.label }}</dt>
      <dd class="hash">
        <code :title="hash.value">{{ shortHash(hash.value) }}</code>
        <UiIconButton icon="copy" size="sm" :label="`Copy the ${hash.label.toLowerCase()} hash`" @click="void copyText(hash.value)" />
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.subject { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-1) var(--space-4); margin: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); font-size: var(--text-sm); }
.row { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
dt { flex: none; width: 72px; color: var(--text-faint); font-size: var(--text-xs); }
dd { display: flex; align-items: center; gap: var(--space-1); min-width: 0; margin: 0; overflow-wrap: anywhere; }
.dim { color: var(--text-dim); }
.hash code { font: var(--text-xs) var(--mono); color: var(--text-dim); }
</style>
