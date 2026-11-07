<script setup lang="ts">
/**
 * Where a side panel lives: a column beside the thread on roomy screens (the thread stays usable), or a modal sheet
 * from the right (tablets) or the bottom (phones, full width) otherwise. Escape closes the sheet; the column closes
 * from its own Close button.
 */
import { UiModal } from '../../ui/index.ts';

withDefaults(defineProps<{ inline: boolean; label: string; phone?: boolean }>(), { phone: false });
const open = defineModel<boolean>('open', { required: true });
defineSlots<{ default: () => unknown }>();
</script>

<template>
  <aside v-if="inline && open" class="column" :aria-label="label" data-testid="chat-panel"><slot /></aside>
  <UiModal v-else-if="!inline" v-model:open="open" :placement="phone ? 'bottom' : 'right'" :width="phone ? '100%' : '480px'" :label="label">
    <div class="sheet" :class="{ phone }" data-testid="chat-panel"><slot /></div>
  </UiModal>
</template>

<style scoped>
.column { min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--surface); animation: ui-rise-in var(--medium) var(--ease); }
.sheet { height: 100%; min-height: 0; }
.sheet.phone { height: min(92dvh, 100%); }
</style>
