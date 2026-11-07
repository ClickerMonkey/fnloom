<script setup lang="ts">
/**
 * Where toasts show: bottom right on wide screens, across the bottom on narrow ones. It only draws `toasts` and
 * reports what the person does (`dismiss`, `action`, and `hold`/`release` while one is being read); the queue that
 * decides what shows is the caller's.
 */
import UiIcon from './UiIcon.vue';
import UiIconButton from './UiIconButton.vue';
import { TONE_ICON } from './icons.ts';
import type { ToastView } from './types.ts';

defineProps<{ toasts: readonly ToastView[] }>();
defineEmits<{ dismiss: [id: number]; action: [id: number]; hold: [id: number]; release: [id: number] }>();
</script>

<template>
  <Teleport to="body">
    <section class="ui-toaster" aria-label="Notifications" aria-live="polite" data-layer>
      <TransitionGroup name="ui-toast" tag="ol" class="stack">
        <li
          v-for="toast in toasts" :key="toast.id" class="toast" :class="`tone-${toast.tone}`" :role="toast.tone === 'danger' ? 'alert' : 'status'"
          @pointerenter="$emit('hold', toast.id)" @pointerleave="$emit('release', toast.id)" @focusin="$emit('hold', toast.id)" @focusout="$emit('release', toast.id)"
        >
          <UiIcon :name="TONE_ICON[toast.tone]" :size="18" class="icon" />
          <div class="text">
            <p class="title">{{ toast.title }}</p>
            <p v-if="toast.body" class="body">{{ toast.body }}</p>
          </div>
          <button v-if="toast.action" type="button" class="action" @click="$emit('action', toast.id)">{{ toast.action }}</button>
          <UiIconButton icon="x" label="Dismiss" size="sm" @click="$emit('dismiss', toast.id)" />
        </li>
      </TransitionGroup>
    </section>
  </Teleport>
</template>

<style scoped>
.ui-toaster {
  position: fixed; z-index: var(--z-toast); right: max(var(--space-4), var(--safe-right)); bottom: max(var(--space-4), var(--safe-bottom));
  width: min(380px, calc(100vw - 2 * var(--space-4))); pointer-events: none;
}
.stack { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.toast {
  display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-3) var(--space-2) var(--space-3) var(--space-4);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); pointer-events: auto;
}
.icon { margin-top: 1px; color: var(--tone); }
.text { flex: 1; min-width: 0; padding-top: 1px; }
.title { margin: 0; font-weight: var(--weight-medium); line-height: var(--leading-tight); }
.body { margin: 2px 0 0; color: var(--text-dim); font-size: var(--text-sm); }
.action {
  flex: none; height: var(--control-sm); padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm);
  background: var(--accent-soft); color: var(--accent); font-weight: var(--weight-medium); font-size: var(--text-sm);
}
.action:hover { background: var(--accent-soft-strong); }
.ui-toast-enter-active { transition: opacity var(--medium) var(--ease), transform var(--slow) var(--spring); }
.ui-toast-leave-active { transition: opacity var(--fast) var(--ease), transform var(--fast) var(--ease); position: absolute; width: 100%; }
.ui-toast-move { transition: transform var(--medium) var(--ease); }
.ui-toast-enter-from { opacity: 0; transform: translateY(12px) scale(0.98); }
.ui-toast-leave-to { opacity: 0; transform: translateX(24px); }
</style>
