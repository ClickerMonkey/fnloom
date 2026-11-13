<script setup lang="ts">
/**
 * The message box of a Claude session: type, then Send (or Ctrl/⌘+Enter). The text stays until the send went through.
 * `hint` says what sending does now (a closed session is resumed first).
 */
import { ref } from 'vue';
import { UiButton, UiTextarea } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ busy?: boolean; hint?: string; placeholder?: string }>(), { busy: false, hint: '', placeholder: 'Message Claude' });
/** `done` is called with whether the message went; the text clears only when it did. */
const emit = defineEmits<{ send: [text: string, done: (sent: boolean) => void] }>();
const text = ref('');

function send(): void {
  const message = text.value.trim();
  if (message === '' || props.busy) { return; }
  emit('send', message, (sent) => { if (sent && text.value.trim() === message) { text.value = ''; } });
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
}
</script>

<template>
  <form class="composer" data-testid="claude-composer" @submit.prevent="send" @keydown="onKey">
    <UiTextarea v-model="text" label="Message" hide-label :placeholder="placeholder" :rows="2" :max-rows="10" />
    <div class="foot">
      <span class="hint">{{ hint }}</span>
      <UiButton type="submit" variant="primary" size="sm" icon="reply" :loading="busy" :disabled="text.trim() === ''" data-testid="claude-send">Send</UiButton>
    </div>
  </form>
</template>

<style scoped>
.composer { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); }
.foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.hint { min-width: 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
