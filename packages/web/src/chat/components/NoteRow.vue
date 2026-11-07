<script setup lang="ts">
/** Something the hub says in the thread (a turn was undone, a system went away): a centred, muted line. */
import type { ChatMessage } from '@harness/core';
import { computed } from 'vue';
import { UiIcon, fullTime } from '../../ui/index.ts';
import { messageText } from '../logic/thread.ts';

const props = withDefaults(defineProps<{ message: ChatMessage; flash?: boolean }>(), { flash: false });
const text = computed(() => messageText(props.message.parts));
</script>

<template>
  <p :id="`m-${message.id}`" class="note" :class="{ flash }" data-testid="note" :title="fullTime(message.createdAt)" tabindex="-1">
    <UiIcon class="icon" name="info" :size="14" />{{ text }}
  </p>
</template>

<style scoped>
.note { width: fit-content; margin: 0 auto; max-width: min(60ch, 100%); padding: var(--space-1) var(--space-3); border-radius: var(--radius); color: var(--text-dim); font-size: var(--text-sm); text-align: center; white-space: pre-wrap; overflow-wrap: anywhere; animation: ui-fade-in var(--medium) var(--ease); }
.icon { display: inline-block; margin-right: var(--space-2); vertical-align: -2px; }
.note:focus { outline: none; }
.flash { animation: ui-flash 1.6s var(--ease); }
</style>
