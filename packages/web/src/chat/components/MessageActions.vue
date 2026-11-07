<script setup lang="ts">
/**
 * A message's action bar: copy (the icon turns into a check), reply, and whichever of edit, retry, undo, details,
 * the turn's tree and copy link the message offers. It shows on hover and keyboard focus on desktop, and on touch
 * through the message's "more" tap; it sits in the message's margin row so it never covers the text.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { UiIconButton, type IconName } from '../../ui/index.ts';
import type { MessageAction } from './types.ts';

const ACTIONS = {
  copy: { icon: 'copy', label: 'Copy' },
  reply: { icon: 'reply', label: 'Reply' },
  edit: { icon: 'edit', label: 'Edit and resend' },
  retry: { icon: 'refresh', label: 'Retry' },
  undo: { icon: 'undo', label: 'Undo this turn' },
  details: { icon: 'info', label: 'Details' },
  tree: { icon: 'tree', label: 'Run tree' },
  link: { icon: 'link', label: 'Copy link' },
} as const satisfies Record<MessageAction, { icon: IconName; label: string }>;

const props = defineProps<{ actions: readonly MessageAction[] }>();
const emit = defineEmits<{ action: [action: MessageAction] }>();
const flashing = ref<MessageAction | undefined>(undefined);
let timer: ReturnType<typeof setTimeout> | undefined;

const shown = computed(() => props.actions.map((action) => ({
  action, ...ACTIONS[action],
  ...(flashing.value === action ? { icon: 'check' as const, label: action === 'link' ? 'Link copied' : 'Copied' } : {}),
})));

function run(action: MessageAction): void {
  emit('action', action);
  if (action === 'copy' || action === 'link') {
    flashing.value = action;
    clearTimeout(timer);
    timer = setTimeout(() => { flashing.value = undefined; }, 1_500);
  }
}

onBeforeUnmount(() => { clearTimeout(timer); });
</script>

<template>
  <div class="msg-actions" role="toolbar" aria-label="Message actions" data-testid="msg-actions">
    <UiIconButton v-for="item in shown" :key="item.action" size="sm" :icon="item.icon" :label="item.label" :data-action="item.action" @click="run(item.action)" />
  </div>
</template>

<style scoped>
.msg-actions { display: inline-flex; flex-wrap: wrap; gap: 2px; }
</style>
