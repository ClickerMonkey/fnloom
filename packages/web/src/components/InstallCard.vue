<script setup lang="ts">
/**
 * Settings › App: installing the app on this device, as the browser allows. It says what it is when it runs
 * installed, offers the browser's prompt or the iPhone sheet, says the page must be secure first, or points at the
 * browser's own menu.
 */
import type { InstallState } from '../state/install.ts';
import { UiBadge, UiButton, UiCard } from '../ui/index.ts';

defineProps<{
  state: InstallState;
  /** The hub's display name, the installed app's name. */
  name: string;
}>();
defineEmits<{ install: [] }>();

/** What the card says in each state. */
const TEXT = {
  installed: 'You’re using the installed app.',
  ready: 'It opens in a window of its own, with a place in your dock, Start menu or home screen.',
  ios: 'On an iPhone or iPad, add it to your Home Screen from Safari’s Share menu.',
  insecure: 'Installing needs the hub’s secure address (https). Open it as shown under “Use it on your phone”, then install from there.',
  browser: 'If your browser can install apps, it’s in the browser’s menu: look for Install app, Add to Home Screen or Add to Dock.',
} as const satisfies Record<InstallState, string>;
</script>

<template>
  <UiCard :title="`Install ${name}`" data-testid="install-card" :data-state="state">
    <p class="text">{{ TEXT[state] }}</p>
    <template v-if="state === 'installed' || state === 'ready' || state === 'ios'" #footer>
      <UiBadge v-if="state === 'installed'" tone="ok">Installed</UiBadge>
      <UiButton v-else icon="download" variant="primary" data-testid="install-app" @click="$emit('install')">{{ state === 'ios' ? 'Show me how' : 'Install app' }}</UiButton>
    </template>
  </UiCard>
</template>

<style scoped>
.text { margin: 0; color: var(--text-dim); }
</style>
