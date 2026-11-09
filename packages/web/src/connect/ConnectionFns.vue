<script setup lang="ts">
/**
 * What a connection may do: one row per fn that acts as the person, with "On" (the chat may use it) and "Ask first"
 * (each use waits for the person's approval). It only draws the switches and reports a change.
 */
import type { ConnectionFnOption } from '@harness/core';
import { UiBadge, UiSwitch } from '../ui/index.ts';
import type { FnSwitchRow } from './logic.ts';

withDefaults(defineProps<{
  rows: readonly FnSwitchRow[];
  /** What each fn does, by full name, when known. */
  hints?: Readonly<Record<string, string>>;
  /** Not connected yet, or someone else's: the switches show but don't change. */
  disabled?: boolean;
}>(), { hints: () => ({}), disabled: false });
const emit = defineEmits<{ change: [local: string, change: Partial<ConnectionFnOption>] }>();

/** A fn's local name in words: `create_event` reads "create event". */
const words = (local: string): string => local.replace(/[_-]+/g, ' ');
/** The same, as a row's title: `Create event`. */
const title = (local: string): string => { const text = words(local); return text.charAt(0).toUpperCase() + text.slice(1); };
</script>

<template>
  <div class="fns" role="table" aria-label="What it may do" data-testid="connection-fns">
    <div class="row head" role="row">
      <span role="columnheader">Fn</span>
      <span role="columnheader" class="switch-head">On</span>
      <span role="columnheader" class="switch-head">Ask first</span>
    </div>
    <div v-for="row in rows" :key="row.local" class="row" role="row" :data-testid="`connection-fn-${row.local}`">
      <span class="what" role="cell">
        <span class="name">{{ title(row.local) }} <UiBadge v-if="row.changed" tone="accent">changed</UiBadge></span>
        <span v-if="hints[row.name]" class="hint">{{ hints[row.name] }}</span>
      </span>
      <span role="cell" class="switch">
        <UiSwitch
          :model-value="row.option.on" :label="`Let the chat ${words(row.local)}`" hide-label :disabled="disabled" data-testid="fn-on"
          @update:model-value="emit('change', row.local, { on: $event })"
        />
      </span>
      <span role="cell" class="switch">
        <UiSwitch
          :model-value="row.option.ask" :label="`Ask before it can ${words(row.local)}`" hide-label :disabled="disabled || !row.option.on" data-testid="fn-ask"
          @update:model-value="emit('change', row.local, { ask: $event })"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
.fns { display: grid; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) 4.5rem 4.5rem; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-top: 1px solid var(--border); }
.row.head { border-top: 0; padding-top: 0; font-size: var(--text-xs); font-weight: var(--weight-medium); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.switch-head, .switch { justify-self: center; }
.what { display: grid; gap: 2px; min-width: 0; }
.name { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-weight: var(--weight-medium); }
.hint { color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
@media (max-width: 480px) { .row { grid-template-columns: minmax(0, 1fr) 3.25rem 3.75rem; gap: var(--space-2); } }
</style>
