<script setup lang="ts">
/**
 * The one confirm before staged inline edits are saved (data-grid "one view"): each record's change in words, and
 * why any didn't save the last time. Saving sends one update per record.
 */
import { UiBanner, UiButton, UiDialog } from '../../ui/index.ts';

defineProps<{
  /** Each record's change in words. */
  lines: readonly string[];
  /** How many fields change. */
  count: number;
  busy: boolean;
  /** Why some didn't save. */
  failed: readonly string[];
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [] }>();
</script>

<template>
  <UiDialog v-model:open="open" :title="`Save ${count} ${count === 1 ? 'change' : 'changes'}?`" role="alertdialog" width="460px">
    <div class="body" data-testid="record-edits-confirm">
      <UiBanner v-if="failed.length > 0" tone="danger">
        {{ failed.length === 1 ? "One record wasn't saved:" : `${failed.length} records weren't saved:` }}
        <ul class="list"><li v-for="line in failed" :key="line">{{ line }}</li></ul>
      </UiBanner>
      <ul class="list changes"><li v-for="line in lines" :key="line" data-testid="record-edit-line">{{ line }}</li></ul>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="record-edits-save" @click="emit('save')">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.body { display: grid; gap: var(--space-3); }
.list { display: grid; gap: var(--space-1); margin: 0; padding-left: var(--space-4); }
.changes { color: var(--text-dim); overflow-wrap: anywhere; }
</style>
