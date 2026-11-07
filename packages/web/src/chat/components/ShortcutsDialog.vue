<script setup lang="ts">
/** The chat's keyboard shortcuts, listed (opened with `?`). */
import { UiDialog, UiKbd } from '../../ui/index.ts';
import { COMPOSER_KEYS, SHORTCUTS } from '../logic/keys.ts';

const ALL = [...SHORTCUTS, ...COMPOSER_KEYS];

const open = defineModel<boolean>('open', { required: true });
</script>

<template>
  <UiDialog v-model:open="open" title="Keyboard shortcuts" width="440px">
    <dl class="keys" data-testid="shortcuts">
      <template v-for="shortcut in ALL" :key="shortcut.label">
        <dt>{{ shortcut.label }}</dt>
        <dd><UiKbd :keys="shortcut.keys" /></dd>
      </template>
    </dl>
  </UiDialog>
</template>

<style scoped>
.keys { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-dim); }
dd { margin: 0; justify-self: end; }
</style>
