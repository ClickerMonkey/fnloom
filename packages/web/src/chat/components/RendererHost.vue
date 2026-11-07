<script setup lang="ts">
/**
 * Mounts a system's renderer and keeps the message safe from it: a renderer that throws shows a quiet placeholder
 * ("Couldn't show this", with Inspect) instead, the error is logged once, and the rest of the thread keeps working.
 */
import { onErrorCaptured, ref, watch } from 'vue';
import { UiButton, UiIcon } from '../../ui/index.ts';
import type { RenderView } from './types.ts';

const props = defineProps<{ view: RenderView; label: string }>();
const emit = defineEmits<{ failed: [error: unknown]; inspect: [] }>();
const broken = ref(false);

watch(() => props.view.component, () => { broken.value = false; });

onErrorCaptured((error) => {
  if (!broken.value) {
    console.error('chat.renderer.failed', { label: props.label, error });
    emit('failed', error);
  }
  broken.value = true;
  return false;
});
</script>

<template>
  <div v-if="broken" class="placeholder" data-testid="renderer-broken">
    <UiIcon name="warning" :size="16" />
    <span class="text">Couldn't show this {{ label }}.</span>
    <UiButton size="sm" variant="ghost" @click="emit('inspect')">Inspect</UiButton>
  </div>
  <div v-else class="host" data-testid="renderer"><component :is="view.component" v-bind="view.props" /></div>
</template>

<style scoped>
.host { min-width: 0; }
.placeholder {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-dim); font-size: var(--text-sm);
}
.text { flex: 1; min-width: 0; }
</style>
