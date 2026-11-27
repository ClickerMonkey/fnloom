<script setup lang="ts">
/**
 * How to install the app on an iPhone or iPad, where Safari has no install prompt: Share, then Add to Home Screen.
 * Opened by **Install app** (the account menu, Settings › App).
 */
import { UiButton, UiDialog } from '../ui/index.ts';

defineProps<{
  /** The hub's display name: the name the app gets on the home screen. */
  name: string;
}>();
const open = defineModel<boolean>('open', { required: true });
</script>

<template>
  <UiDialog v-model:open="open" title="Add to Home Screen" :description="`Put ${name} on your home screen, like any other app.`" width="420px">
    <ol class="steps" data-testid="install-sheet">
      <li>
        <span>Tap <strong>Share</strong></span>
        <!-- Safari's share glyph: a box with an arrow out of it -->
        <svg class="glyph" viewBox="0 0 24 24" aria-label="the Share button" role="img"><path d="M12 3v12M8 7l4-4 4 4" /><path d="M7 10H5v11h14V10h-2" /></svg>
        <span class="dim">at the bottom of Safari (at the top on an iPad).</span>
      </li>
      <li><span>Scroll down and tap <strong>Add to Home Screen</strong>.</span></li>
      <li><span>Tap <strong>Add</strong>. Open {{ name }} from your home screen from now on.</span></li>
    </ol>
    <p class="dim note">Only Safari can add it. In another browser, open this page in Safari first.</p>
    <template #footer>
      <UiButton variant="primary" @click="open = false">Got it</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.steps { display: grid; gap: var(--space-3); margin: 0; padding-left: var(--space-5); }
.steps li { line-height: var(--leading-relaxed, 1.5); }
.steps li span { margin-right: var(--space-1); }
.glyph { display: inline-block; width: 20px; height: 20px; margin: 0 var(--space-1) -4px 0; fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.dim { color: var(--text-dim); }
.note { margin: var(--space-4) 0 0; font-size: var(--text-sm); }
</style>
