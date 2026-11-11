<script setup lang="ts">
/**
 * One stretch of the model's reasoning, folded to a "Reasoning" toggle where it happened; it shimmers while it is still
 * arriving, and opened shows the text. Whether it is open is the caller's (`v-model:open`).
 */
import { UiIcon } from '../../ui/index.ts';

defineProps<{ text: string; thinking: boolean }>();
const open = defineModel<boolean>('open', { required: true });
</script>

<template>
  <div class="reasoning" data-testid="reasoning">
    <button type="button" class="reasoning-toggle touch-target" :class="{ shimmer: thinking }" :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
      <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      {{ thinking ? 'Reasoning…' : 'Reasoning' }}
    </button>
    <p v-if="open" class="reasoning-text">{{ text }}</p>
  </div>
</template>

<style scoped>
.reasoning { display: grid; gap: var(--space-1); }
.reasoning-toggle { display: inline-flex; align-items: center; gap: 4px; justify-self: start; padding: 2px var(--space-1); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-faint); font-size: var(--text-sm); }
.reasoning-toggle:hover { color: var(--text-dim); background: var(--surface-2); }
.reasoning-text { margin: 0; padding: var(--space-2) var(--space-3); border-left: 2px solid var(--border-strong); color: var(--text-dim); font-size: var(--text-sm); white-space: pre-wrap; }
.shimmer {
  background: linear-gradient(90deg, var(--text-faint) 40%, var(--text) 50%, var(--text-faint) 60%) 0 0 / 300% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; animation: ui-shimmer 2s linear infinite;
}
</style>
