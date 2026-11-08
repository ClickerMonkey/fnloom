<script setup lang="ts">
/**
 * One value of a gin type, read only, drawn by its shape: text (long text folds), numbers, yes or no, enum labels,
 * dates and times in the reader's locale, durations, colour swatches, lists and tuples as numbered items, maps as a
 * key and value table, objects as labelled fields (optional fields that aren't set are left out), nullables,
 * unions by the option the value fits, and named types by their system's own component (read only) when there is
 * one. Composites fold, and start folded below the first levels when they are large.
 */
import type { Json } from '@harness/core';
import { computed, inject, ref } from 'vue';
import { UiBadge, UiCodeBlock, UiIconButton } from '../../ui/index.ts';
import {
  colorText, dateText, durationText, enumText, isComposite, optionOf, presentFields, shapeOf, summary, timestampText,
} from '../logic/display.ts';
import { mapPairs, type FormNode } from '../logic/form.ts';
import { drawerFor, GIN_INPUTS, NO_INPUTS } from '../registry.ts';

const props = withDefaults(defineProps<{
  node: FormNode;
  value: Json | undefined;
  /** What the value is (a field's label, `Item 2`), for the fold button and screen readers. */
  label?: string;
  /** How deep in the value this node is; large composites start folded from depth 2. */
  depth?: number;
}>(), { label: 'Value', depth: 0 });

const lookup = inject(GIN_INPUTS, NO_INPUTS);
const drawer = computed(() => drawerFor(props.node, lookup));
const shape = computed(() => shapeOf(props.node));

/** Long text folds to its first lines. */
const LONG_TEXT = 600;
/** Composites with more than this many items start folded below the first levels. */
const LARGE = 8;

const items = computed<readonly Json[]>(() => (Array.isArray(props.value) ? props.value : []));
const pairs = computed(() => mapPairs(props.value));
const fields = computed(() => (shape.value.kind === 'obj' ? presentFields(shape.value, props.value) : []));
const missing = computed(() => (shape.value.kind === 'obj' ? shape.value.fields.filter((f) => !f.optional && !fields.value.some((p) => p.field.name === f.name)) : []));
const size = computed(() => (shape.value.kind === 'map' ? pairs.value.length : shape.value.kind === 'obj' ? fields.value.length : items.value.length));
const folded = ref(props.depth >= 2 && size.value > LARGE);
const text = computed(() => (typeof props.value === 'string' ? props.value : ''));
const textOpen = ref(false);
const longText = computed(() => text.value.length > LONG_TEXT);
const shownText = computed(() => (longText.value && !textOpen.value ? `${text.value.slice(0, LONG_TEXT)}…` : text.value));
const color = computed(() => colorText(props.value));
const jsonText = computed(() => (props.value === undefined ? '' : JSON.stringify(props.value, null, 2)));
const option = computed(() => (shape.value.kind === 'or' ? shape.value.options[optionOf(shape.value, props.value)] : undefined));
const systemValue = computed(() => (drawer.value.kind === 'system' ? drawer.value.input.decode(props.value) : undefined));
</script>

<template>
  <div class="gin-value" :class="`kind-${shape.kind}`" data-testid="gin-value">
    <span v-if="value === undefined" class="dim">Not set</span>

    <component
      :is="drawer.input.component" v-else-if="drawer.kind === 'system'" v-bind="drawer.input.props"
      :model-value="systemValue" :problems="[]" readonly
    />

    <template v-else-if="drawer.kind === 'json'">
      <code v-if="jsonText.length <= 60 && !jsonText.includes('\n')" class="inline">{{ jsonText }}</code>
      <UiCodeBlock v-else :code="jsonText" language="json" :filename="drawer.name || 'JSON'" :max-height="320" />
    </template>

    <template v-else-if="shape.kind === 'text'">
      <span v-if="typeof value !== 'string'" class="inline">{{ JSON.stringify(value) }}</span>
      <span v-else-if="text === ''" class="dim">Empty</span>
      <div v-else class="text" :class="{ block: text.includes('\n') || longText }">{{ shownText }}</div>
      <button v-if="longText" type="button" class="more" @click="textOpen = !textOpen">{{ textOpen ? 'Show less' : `Show all ${text.length.toLocaleString()} characters` }}</button>
    </template>

    <span v-else-if="shape.kind === 'num'" class="number">{{ summary(shape, value) }}</span>
    <UiBadge v-else-if="shape.kind === 'bool'" :tone="value === true ? 'ok' : 'neutral'">{{ value === true ? 'Yes' : 'No' }}</UiBadge>
    <UiBadge v-else-if="shape.kind === 'enum'" tone="accent">{{ enumText(shape, value) }}</UiBadge>
    <code v-else-if="shape.kind === 'literal'" class="inline">{{ JSON.stringify(shape.value) }}</code>
    <time v-else-if="shape.kind === 'date' && typeof value === 'string'" :datetime="value">{{ dateText(value) }}</time>
    <time v-else-if="shape.kind === 'timestamp' && typeof value === 'string'" :datetime="value" :title="value">{{ timestampText(value) }}</time>
    <span v-else-if="shape.kind === 'duration' && typeof value === 'number'" class="number" :title="`${value} ms`">{{ durationText(value) }}</span>
    <span v-else-if="shape.kind === 'color' && color" class="color"><span class="swatch" :style="{ background: color }" aria-hidden="true"></span><code>{{ color }}</code></span>

    <span v-else-if="shape.kind === 'nullable' && value === null" class="dim">None</span>
    <GinValueNode v-else-if="shape.kind === 'nullable'" :node="shape.inner" :value="value" :label="label" :depth="depth" />
    <GinValueNode v-else-if="shape.kind === 'or' && option" :node="option.node" :value="value" :label="label" :depth="depth" />

    <div v-else-if="isComposite(shape)" class="composite">
      <div v-if="depth > 0" class="fold-bar">
        <UiIconButton
          :icon="folded ? 'chevron-right' : 'chevron-down'" size="sm" :label="folded ? `Show ${label}` : `Hide ${label}`" :pressed="!folded"
          @click="folded = !folded"
        />
        <span class="summary">{{ summary(shape, value) }}</span>
      </div>
      <template v-if="!folded">
        <ol v-if="shape.kind === 'list' || shape.kind === 'tuple'" class="items">
          <li v-for="(item, at) in items" :key="at" class="item">
            <span class="index" aria-hidden="true">{{ at + 1 }}</span>
            <GinValueNode
              class="grow" :node="shape.kind === 'list' ? shape.item : (shape.elements[at] ?? { kind: 'json', docs: '' })" :value="item"
              :label="`${label} ${at + 1}`" :depth="depth + 1"
            />
          </li>
          <li v-if="items.length === 0" class="dim">No items</li>
        </ol>
        <table v-else-if="shape.kind === 'map'" class="map">
          <thead><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
          <tbody>
            <tr v-for="(pair, at) in pairs" :key="at">
              <td><GinValueNode :node="shape.key" :value="pair.key" :label="`Key ${at + 1}`" :depth="depth + 1" /></td>
              <td><GinValueNode :node="shape.value" :value="pair.value" :label="`Value ${at + 1}`" :depth="depth + 1" /></td>
            </tr>
            <tr v-if="pairs.length === 0"><td colspan="2" class="dim">No entries</td></tr>
          </tbody>
        </table>
        <dl v-else-if="shape.kind === 'obj'" class="fields">
          <div v-for="entry in fields" :key="entry.field.name" class="field" :data-field="entry.field.name">
            <dt :title="entry.field.docs || undefined">{{ entry.field.label }}</dt>
            <dd><GinValueNode :node="entry.field.node" :value="entry.value" :label="entry.field.label" :depth="depth + 1" /></dd>
          </div>
          <div v-for="field in missing" :key="field.name" class="field">
            <dt>{{ field.label }}</dt>
            <dd class="dim">Not set</dd>
          </div>
          <p v-if="fields.length === 0 && missing.length === 0" class="dim">No fields</p>
        </dl>
      </template>
    </div>

    <code v-else class="inline">{{ jsonText }}</code>
  </div>
</template>

<style scoped>
.gin-value { min-width: 0; font-size: var(--text-sm); color: var(--text); overflow-wrap: anywhere; }
.dim { color: var(--text-faint); }
.inline { font-family: var(--mono); font-size: var(--text-xs); color: var(--text-dim); }
.text.block { white-space: pre-wrap; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--surface-2); }
.more { margin-top: var(--space-1); padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.more:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 4px; }
.number { font-variant-numeric: tabular-nums; }
.color { display: inline-flex; align-items: center; gap: var(--space-2); }
.swatch { width: 18px; height: 18px; border: 1px solid var(--border-strong); border-radius: 5px; }
.composite { display: grid; gap: var(--space-2); min-width: 0; }
.fold-bar { display: flex; align-items: center; gap: var(--space-1); color: var(--text-dim); }
.summary { font-size: var(--text-xs); }
.items { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.item { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.index { flex: none; min-width: 2ch; color: var(--text-faint); font: var(--text-xs) var(--mono); text-align: right; }
.grow { flex: 1; min-width: 0; }
.map { width: 100%; border-collapse: collapse; table-layout: fixed; }
.map th { padding: var(--space-1) var(--space-2); color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); text-align: left; border-bottom: 1px solid var(--border); }
.map td { padding: var(--space-2); border-bottom: 1px solid var(--border); vertical-align: top; }
.fields { display: grid; gap: var(--space-2); margin: 0; }
.field { display: grid; grid-template-columns: minmax(96px, 30%) minmax(0, 1fr); gap: var(--space-3); align-items: baseline; min-width: 0; }
.field dt { color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.field dd { margin: 0; min-width: 0; }
@container (max-width: 420px) {
  .field { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
</style>
