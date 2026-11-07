<script setup lang="ts">
/** Asks before something that can't be taken back: what will happen, and a button that says it. */
import { UiButton, UiDialog } from '../../ui/index.ts';

withDefaults(defineProps<{ title: string; body: string; confirm: string; busy?: boolean; danger?: boolean }>(), { busy: false, danger: true });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <UiDialog v-model:open="open" :title="title" role="alertdialog" width="420px">
    <p class="body">{{ body }}</p>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton :variant="danger ? 'danger' : 'primary'" :loading="busy" data-testid="confirm" @click="emit('confirm')">{{ confirm }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.body { margin: 0; color: var(--text-dim); }
</style>
