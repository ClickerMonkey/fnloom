<script setup lang="ts">
/**
 * A dialog (`v-model:open`) with a title, an optional description, a close button, the body (default slot) and a
 * footer for its actions (`footer` slot). The body scrolls when it is taller than the screen; header and footer stay.
 */
import { useId } from 'vue';
import UiIconButton from './UiIconButton.vue';
import UiModal from './UiModal.vue';

withDefaults(defineProps<{
  title: string;
  /** The title's hover text (`title` attribute), such as the raw names behind a humanized title. */
  titleHint?: string | undefined;
  description?: string;
  role?: 'dialog' | 'alertdialog';
  width?: string;
}>(), { titleHint: undefined, description: '', role: 'dialog', width: '480px' });

const open = defineModel<boolean>('open', { required: true });
const id = useId();

const slots = defineSlots<{ default?: () => unknown; footer?: () => unknown }>();
</script>

<template>
  <UiModal v-model:open="open" :role="role" :width="width" :labelled-by="`${id}-title`" :described-by="description === '' ? undefined : `${id}-desc`">
    <header class="head">
      <div class="titles">
        <h2 :id="`${id}-title`" class="title" :title="titleHint">{{ title }}</h2>
        <p v-if="description !== ''" :id="`${id}-desc`" class="description">{{ description }}</p>
      </div>
      <UiIconButton icon="x" label="Close" size="sm" @click="open = false" />
    </header>
    <div v-if="slots.default" class="body"><slot /></div>
    <footer v-if="slots.footer" class="foot"><slot name="footer" /></footer>
  </UiModal>
</template>

<style scoped>
.head { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-5) var(--space-5) var(--space-3); }
.titles { flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-strong); }
.description { margin: var(--space-1) 0 0; color: var(--text-dim); font-size: var(--text-sm); }
.body { flex: 1; min-height: 0; overflow: auto; padding: var(--space-2) var(--space-5) var(--space-5); }
.foot {
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2);
  padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); background: var(--surface-2);
}
</style>
