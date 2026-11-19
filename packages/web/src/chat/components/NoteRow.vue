<script setup lang="ts">
/**
 * Something the hub says in the thread (a turn was undone): a centred, muted line. An undo note keeps the question
 * and answer it took out of the thread behind a toggle, dimmed and struck, so nothing is lost from view for good.
 */
import type { ChatMessage } from '@harness/core';
import { computed, ref } from 'vue';
import { UiIcon, fullTime } from '../../ui/index.ts';
import { clamp } from '../logic/format.ts';
import { messageText } from '../logic/thread.ts';

const props = withDefaults(defineProps<{ message: ChatMessage; undone?: readonly ChatMessage[]; flash?: boolean }>(), { undone: () => [], flash: false });
const text = computed(() => messageText(props.message.parts));
const open = ref(false);
const shown = computed(() => props.undone.map((m) => ({ id: m.id, who: m.role === 'user' ? 'Asked' : 'Answered', text: clamp(messageText(m.parts), 160) })).filter((m) => m.text !== ''));
</script>

<template>
  <div :id="`m-${message.id}`" class="note" :class="{ flash }" data-testid="note" :title="message.createdAt > 0 ? fullTime(message.createdAt) : undefined" tabindex="-1">
    <p class="line"><UiIcon class="icon" name="info" :size="14" />{{ text }}</p>
    <button v-if="shown.length > 0" type="button" class="toggle" :aria-expanded="open ? 'true' : 'false'" data-testid="note-undone-toggle" @click="open = !open">
      <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />{{ open ? 'Hide' : 'Show' }} what was undone
    </button>
    <ul v-if="open" class="undone" data-testid="note-undone">
      <li v-for="m in shown" :key="m.id"><span class="who">{{ m.who }}</span> <s>{{ m.text }}</s></li>
    </ul>
  </div>
</template>

<style scoped>
.note { display: grid; justify-items: center; gap: 2px; width: fit-content; margin: 0 auto; max-width: min(60ch, 100%); padding: var(--space-1) var(--space-3); border-radius: var(--radius); color: var(--text-dim); font-size: var(--text-sm); text-align: center; overflow-wrap: anywhere; animation: ui-fade-in var(--medium) var(--ease); }
.line { margin: 0; white-space: pre-wrap; }
.icon { display: inline-block; margin-right: var(--space-2); vertical-align: -2px; }
.toggle { display: inline-flex; align-items: center; gap: 2px; min-height: 32px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-faint); font-size: var(--text-xs); }
.toggle:hover { color: var(--text-dim); background: var(--surface-2); }
.toggle:focus-visible { outline: none; box-shadow: var(--ring); }
.undone { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; color: var(--text-faint); font-size: var(--text-xs); text-align: left; }
.who { font-weight: var(--weight-medium); }
.note:focus { outline: none; }
.flash { animation: ui-flash 1.6s var(--ease); }
</style>
