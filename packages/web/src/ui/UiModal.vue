<script setup lang="ts">
/**
 * A modal layer over the page (`v-model:open`): a dimmed backdrop and a panel placed in the centre (dialogs) or
 * against an edge (drawers and sheets). Focus moves in, Tab stays inside, the page behind doesn't scroll, and Escape
 * or a press on the backdrop closes it; focus then goes back where it was.
 */
import { ref } from 'vue';
import { useOverlay } from './overlay.ts';
import type { ModalPlacement } from './types.ts';

withDefaults(defineProps<{
  placement?: ModalPlacement;
  /** The panel's accessible name, when no element names it. */
  label?: string | undefined;
  /** The id of the element that names the panel. */
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  /** `alertdialog` for confirmations that need an answer. */
  role?: 'dialog' | 'alertdialog';
  /** The panel's width for `center`, `left` and `right`. */
  width?: string;
}>(), { placement: 'center', label: undefined, labelledBy: undefined, describedBy: undefined, role: 'dialog', width: '480px' });

const open = defineModel<boolean>('open', { required: true });
const panel = ref<HTMLElement | null>(null);

useOverlay(open, panel, { onClose: () => { open.value = false; }, modal: true, dismissOnOutside: true, takeFocus: true });

defineSlots<{ default: () => unknown }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-modal">
      <div v-if="open" class="ui-modal" :class="placement" data-layer>
        <div class="backdrop" aria-hidden="true" />
        <div
          ref="panel" class="panel" :role="role" aria-modal="true" :aria-label="label" :aria-labelledby="labelledBy"
          :aria-describedby="describedBy" tabindex="-1" :style="{ '--modal-width': width }"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-modal { position: fixed; inset: 0; z-index: var(--z-dialog); display: grid; }
.backdrop { position: absolute; inset: 0; background: var(--overlay); backdrop-filter: blur(2px); }
.panel {
  position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden;
  background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg);
}
.panel:focus-visible { outline: none; }

.center { place-items: center; padding: max(var(--space-4), var(--safe-top)) var(--space-4) max(var(--space-4), var(--safe-bottom)); }
.center .panel { width: min(var(--modal-width), 100%); max-height: 100%; border: 1px solid var(--border); border-radius: var(--radius-xl); }
.left .panel, .right .panel { width: min(var(--modal-width), 88vw); height: 100%; }
.left .panel { justify-self: start; border-right: 1px solid var(--border); padding-left: var(--safe-left); }
.right .panel { justify-self: end; border-left: 1px solid var(--border); padding-right: var(--safe-right); }
.bottom .panel { align-self: end; width: 100%; max-height: 88vh; border-radius: var(--radius-xl) var(--radius-xl) 0 0; padding-bottom: var(--safe-bottom); }

.ui-modal-enter-active, .ui-modal-leave-active { transition: opacity var(--medium) var(--ease); }
.ui-modal-enter-active .panel, .ui-modal-leave-active .panel { transition: transform var(--slow) var(--ease), opacity var(--medium) var(--ease); }
.ui-modal-enter-from, .ui-modal-leave-to { opacity: 0; }
.ui-modal-enter-from.center .panel, .ui-modal-leave-to.center .panel { transform: translateY(8px) scale(0.98); opacity: 0; }
.ui-modal-enter-from.left .panel, .ui-modal-leave-to.left .panel { transform: translateX(-100%); }
.ui-modal-enter-from.right .panel, .ui-modal-leave-to.right .panel { transform: translateX(100%); }
.ui-modal-enter-from.bottom .panel, .ui-modal-leave-to.bottom .panel { transform: translateY(100%); }
</style>
