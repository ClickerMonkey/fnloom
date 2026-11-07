<script setup lang="ts">
/**
 * The parts a person wrote, in order: their words (line breaks kept, long tokens wrapping), mention chips, command
 * chips, invocation cards and files. What the hub and hooks added for the model is not here: the message shows it
 * as one dimmed "Added for the model" row.
 */
import type { MessagePart, QualifiedName, RunId } from '@harness/core';
import { UiIcon } from '../../ui/index.ts';
import { formatBytes } from '../logic/format.ts';
import { fnLabel } from '../logic/labels.ts';
import type { MentionPart as Mention } from '../logic/thread.ts';
import MentionChip from './MentionChip.vue';

defineProps<{
  parts: readonly MessagePart[];
  /** A command's name for its context (`fs/tree` → `tree`). */
  commandName: (context: QualifiedName) => string;
}>();
const emit = defineEmits<{ hover: [part: Mention, anchor: HTMLElement]; leave: []; open: [part: Mention, anchor: HTMLElement]; run: [run: RunId] }>();
</script>

<template>
  <span class="parts">
    <template v-for="(part, i) in parts" :key="i">
      <span v-if="part.type === 'text'" class="text">{{ part.text }}</span>
      <MentionChip
        v-else-if="part.type === 'mention'" :label="part.label" :provider="part.provider"
        @hover="emit('hover', part, $event)" @leave="emit('leave')" @open="emit('open', part, $event)"
      />
      <span v-else-if="part.type === 'command'" class="command" data-testid="command-chip" :title="part.context">
        /{{ commandName(part.context) }}<span v-for="(value, name) in part.args" :key="name" class="arg">{{ value }}</span>
      </span>
      <button v-else-if="part.type === 'invocation'" type="button" class="invocation" data-testid="invocation-chip" @click="emit('run', part.run)">
        <UiIcon name="fn" :size="13" /> {{ fnLabel(part.fn) }}
      </button>
      <span v-else-if="part.type === 'file'" class="file" data-testid="file-chip" :title="`${part.name} · ${part.ref.mime}`">
        <UiIcon :name="part.ref.mime.startsWith('image/') ? 'image' : 'file'" :size="13" />
        <span class="file-name">{{ part.name }}</span>
        <span class="file-size">{{ formatBytes(part.ref.size) }}</span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.parts { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.command, .invocation, .file {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 24px; padding: 0 8px; margin: 0 1px; vertical-align: baseline;
  border-radius: var(--radius-full); font-size: 0.92em; white-space: nowrap;
}
.command { background: color-mix(in oklch, currentColor 12%, transparent); font-family: var(--mono); }
.arg { margin-left: 6px; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; }
.invocation { border: 1px solid color-mix(in oklch, currentColor 30%, transparent); background: transparent; color: inherit; font: inherit; font-size: 0.92em; }
.invocation:focus-visible { outline: none; box-shadow: var(--ring); }
.file { background: color-mix(in oklch, currentColor 10%, transparent); }
.file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.file-size { opacity: 0.7; }
</style>
