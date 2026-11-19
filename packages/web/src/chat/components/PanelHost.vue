<script setup lang="ts">
/**
 * Where a side panel lives: a column beside the thread on roomy screens (the thread stays usable), or a modal sheet
 * from the right (tablets) or the bottom (phones, full width) otherwise. Escape closes the sheet; the column closes
 * from its own Close button. Given `v-model:width` and `max`, the column and the right sheet are that many px wide
 * and their left edge drags it (or its arrow keys move it; double-click puts it back), between the least and `max`;
 * without, the column fills the place its page gives it and the sheet is `SHEET_WIDTH` wide.
 */
import { UiModal, UiSplitter } from '../../ui/index.ts';
import { PANEL_WIDTH } from '../../state/layout.ts';

withDefaults(defineProps<{ inline: boolean; label: string; phone?: boolean; max?: number | undefined }>(), { phone: false, max: undefined });
const open = defineModel<boolean>('open', { required: true });
const width = defineModel<number | undefined>('width', { default: undefined });
/** The right sheet's width when the page sets none, in px. */
const SHEET_WIDTH = 480;
defineSlots<{ default: () => unknown }>();
</script>

<template>
  <aside v-if="inline && open" class="column" :aria-label="label" data-testid="chat-panel">
    <UiSplitter
      v-if="width !== undefined && max !== undefined" :model-value="width" class="edge" side="after" :label="`${label} width`"
      :min="PANEL_WIDTH.min" :max="max" :reset="PANEL_WIDTH.reset" @update:model-value="width = $event"
    />
    <slot />
  </aside>
  <UiModal v-else-if="!inline" v-model:open="open" :placement="phone ? 'bottom' : 'right'" :width="phone ? '100%' : `${width ?? SHEET_WIDTH}px`" :label="label">
    <div class="sheet" :class="{ phone }" data-testid="chat-panel">
      <UiSplitter
        v-if="!phone && width !== undefined && max !== undefined" :model-value="width" class="edge" side="after" :label="`${label} width`"
        :min="PANEL_WIDTH.min" :max="max" :reset="PANEL_WIDTH.reset" @update:model-value="width = $event"
      />
      <slot />
    </div>
  </UiModal>
</template>

<style scoped>
.column { position: relative; min-width: 0; min-height: 0; border-left: 1px solid var(--border); background: var(--surface); animation: ui-rise-in var(--medium) var(--ease); }
.sheet { position: relative; height: 100%; min-height: 0; }
/* on a phone the sheet always takes the whole height the modal allows, never a short partial sheet */
.sheet.phone { height: 88vh; height: 88dvh; }
/* the drag handle lies along the panel's left edge, over its border */
.column > .edge, .sheet > .edge { position: absolute; top: 0; bottom: 0; left: -1px; z-index: 2; background: transparent; }
</style>
