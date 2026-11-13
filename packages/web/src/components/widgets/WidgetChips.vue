<script setup lang="ts">
/**
 * A widget's chip row (controls-bar: always visible, never a dialog): its presets first (a tap sets their args and
 * runs), then one chip per shown control with its label and value ("Any" when unset). A chip opens a popover with the
 * editor for its argument: its choices (an optional one has an "Any" row), the relative dates for a date, and a typed
 * value where one may be typed. Changes are staged: the chip marks itself and Apply beside the row runs them together.
 * It wraps on a phone. Without `editable` (a preview, a page that can't run it) the chips only show their values.
 */
import type { Json, WidgetPreset, WidgetShownControl } from '@harness/core';
import { computed, ref } from 'vue';
import GinForm from '../../gin/GinForm.vue';
import { UiButton, UiIcon, UiPopover } from '../../ui/index.ts';
import { chipText, relativeChoices, sameValue, type ChipValue } from './widgets.ts';

const props = defineProps<{
  controls: readonly WidgetShownControl[];
  presets: readonly WidgetPreset[];
  /** A chip's value now (staged, else the one it ran with). */
  currentOf: (arg: string) => ChipValue | undefined;
  /** Whether there are staged changes to apply. */
  dirty: boolean;
  busy: boolean;
  editable: boolean;
}>();
const emit = defineEmits<{ stage: [arg: string, value: ChipValue]; apply: []; discard: []; preset: [preset: WidgetPreset] }>();

const anchors = ref<Record<string, HTMLElement | null>>({});
const openArg = ref<string | undefined>(undefined);
const open = computed({ get: () => openArg.value !== undefined, set: (on: boolean) => { if (!on) { openArg.value = undefined; } } });
const control = computed(() => props.controls.find((c) => c.arg === openArg.value));
const relatives = computed(() => (control.value === undefined ? [] : relativeChoices(control.value)));
/** Whether the open chip takes a typed value: no choices, or choices with `custom`. */
const typed = computed(() => control.value !== undefined && (control.value.choices === undefined || control.value.custom));
const literal = computed((): Json | undefined => {
  const value = control.value === undefined ? undefined : props.currentOf(control.value.arg);
  return value === undefined || value === null || 'relative' in value ? undefined : value.literal;
});

function setAnchor(arg: string, el: unknown): void {
  anchors.value[arg] = el instanceof HTMLElement ? el : null;
}

function pick(value: ChipValue): void {
  const arg = openArg.value;
  if (arg === undefined) { return; }
  emit('stage', arg, value);
  openArg.value = undefined;
}

const changed = (c: WidgetShownControl): boolean => !sameValue(props.currentOf(c.arg), c.value);
const isPicked = (value: ChipValue): boolean => control.value !== undefined && sameValue(props.currentOf(control.value.arg), value);
</script>

<template>
  <div v-if="controls.length > 0 || presets.length > 0" class="chips" data-testid="widget-chips">
    <button
      v-for="preset in presets" :key="preset.label" type="button" class="preset" :disabled="!editable || busy" data-testid="widget-preset"
      @click="emit('preset', preset)"
    >
      {{ preset.label }}
    </button>
    <button
      v-for="c in controls" :key="c.arg" :ref="(el) => setAnchor(c.arg, el)" type="button" class="chip" :class="{ changed: changed(c) }" :disabled="!editable"
      :aria-expanded="openArg === c.arg" aria-haspopup="dialog" :data-arg="c.arg" data-testid="widget-chip" @click="openArg = openArg === c.arg ? undefined : c.arg"
    >
      <span class="label">{{ c.label }}</span>
      <span class="value">{{ chipText(c, currentOf(c.arg)) }}</span>
      <UiIcon v-if="editable" name="chevron-down" :size="12" />
    </button>
    <span v-if="dirty" class="apply">
      <UiButton size="sm" variant="primary" :loading="busy" data-testid="widget-apply" @click="emit('apply')">Apply</UiButton>
      <UiButton size="sm" variant="ghost" :disabled="busy" data-testid="widget-discard" @click="emit('discard')">Reset</UiButton>
    </span>
    <UiPopover v-model:open="open" :anchor="openArg === undefined ? null : anchors[openArg]" :label="control?.label">
      <div v-if="control" class="editor" data-testid="widget-chip-editor">
        <ul v-if="control.choices || relatives.length > 0" class="options" role="listbox" :aria-label="control.label">
          <li v-for="choice in control.choices ?? []" :key="choice.label">
            <button
              type="button" class="option" role="option" :aria-selected="isPicked(choice.value ?? null)" data-testid="widget-chip-choice"
              @click="pick(choice.value ?? null)"
            >
              <span :class="{ any: choice.value === undefined }">{{ choice.label }}</span>
              <UiIcon v-if="isPicked(choice.value ?? null)" name="check" :size="14" />
            </button>
          </li>
          <li v-if="!control.choices && control.optional">
            <button type="button" class="option" role="option" :aria-selected="isPicked(null)" data-testid="widget-chip-choice" @click="pick(null)">
              <span class="any">Any</span>
              <UiIcon v-if="isPicked(null)" name="check" :size="14" />
            </button>
          </li>
          <li v-for="rel in relatives" :key="rel.label">
            <button type="button" class="option" role="option" :aria-selected="isPicked(rel.value)" data-testid="widget-chip-relative" @click="pick(rel.value)">
              <span>{{ rel.label }}</span>
              <UiIcon v-if="isPicked(rel.value)" name="check" :size="14" />
            </button>
          </li>
        </ul>
        <GinForm
          v-if="typed" :key="control.arg" class="typed" :type="control.argType" :initial="literal" :label="control.label" submit-label="Set"
          @submit="pick({ literal: $event })" @cancel="openArg = undefined"
        />
      </div>
    </UiPopover>
  </div>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
.chip, .preset {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: var(--control-sm); padding: 0 var(--space-3);
  border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); color: var(--text); font: inherit; font-size: var(--text-sm); cursor: pointer;
}
.preset { border-style: dashed; color: var(--text-dim); }
.chip:hover:not(:disabled), .preset:hover:not(:disabled) { border-color: var(--text-faint); }
.chip:focus-visible, .preset:focus-visible { outline: none; box-shadow: var(--ring); }
.chip:disabled, .preset:disabled { cursor: default; }
.chip.changed { border-color: var(--accent); background: var(--accent-soft); }
.label { color: var(--text-dim); white-space: nowrap; }
.value { min-width: 0; font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apply { display: inline-flex; gap: var(--space-1); }
.editor { display: grid; gap: var(--space-2); min-width: 14rem; max-width: min(24rem, 100vw - 32px); padding: var(--space-2); }
.options { display: grid; gap: 2px; max-height: 18rem; margin: 0; padding: 0; overflow: auto; list-style: none; }
.option {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); width: 100%; min-height: 36px; padding: 0 var(--space-2);
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.option:hover, .option[aria-selected="true"] { background: var(--surface-2); }
.option:focus-visible { outline: none; box-shadow: inset var(--ring); }
.any { color: var(--text-dim); font-style: italic; }
.typed { padding: var(--space-1); border-top: 1px solid var(--border); }
.options + .typed { padding-top: var(--space-2); }
</style>
