<script setup lang="ts">
/**
 * The input for one gin type, chosen by its form node: text (one line or many), numbers, a switch, choices
 * (segmented for a few, a list for more), dates, date-times, durations, colours, JSON, lists (add, remove, reorder),
 * tuples, maps (key and value rows), objects (optional fields can be removed and added back), nullables, unions (a
 * switch between options) and named types (a system's own input when it has one). It draws the draft it is given and
 * emits the changed draft; problems show under the field they belong to.
 */
import { Json } from '@harness/core';
import { computed, inject, useId } from 'vue';
import { UiButton, UiField, UiIconButton, UiInput, UiSegmented, UiSwitch, UiTextarea } from '../../ui/index.ts';
import { eventValue } from '../dom.ts';
import { FORM_INPUTS } from './inputs.ts';
import { constraintHint, draftOf, problemAt, type Draft, type FormNode, type FormProblem } from './model.ts';

const props = withDefaults(defineProps<{
  node: FormNode;
  draft: Draft;
  path: string;
  problems: readonly FormProblem[];
  label: string;
  /** Docs from the field that holds this value. */
  docs?: string;
  required?: boolean;
  /** Draw nested objects without their own frame. */
  flat?: boolean;
}>(), { docs: '', required: false, flat: false });

const emit = defineEmits<{ update: [draft: Draft] }>();
const lookup = inject(FORM_INPUTS, () => undefined);
const id = useId();

const error = computed(() => problemAt(props.problems, props.path));
const hint = computed(() => [props.docs || props.node.docs, constraintHint(props.node)].filter((s) => s !== '').join(' · '));

const text = computed(() => (props.draft.kind === 'text' ? props.draft.text : ''));
/** Inputs of type number hand back numbers (Vue casts them); the draft keeps the text. */
const setText = (value: string | number): void => { emit('update', { kind: 'text', text: String(value) }); };
const bool = computed(() => props.draft.kind === 'bool' && props.draft.value);
const items = computed(() => (props.draft.kind === 'items' ? props.draft.items : []));
const entries = computed(() => (props.draft.kind === 'entries' ? props.draft.entries : []));
const join = (key: string | number): string => (props.path === '' ? String(key) : `${props.path}.${key}`);

const custom = computed(() => (props.node.kind === 'ref' ? lookup(props.node.name) : undefined));
const refText = computed(() => (props.draft.kind === 'value' && props.draft.value !== undefined ? JSON.stringify(props.draft.value, null, 2) : ''));

function setCustom(value: unknown): void {
  const parsed = Json.safeParse(value);
  emit('update', { kind: 'value', value: parsed.success ? parsed.data : undefined });
}

function setRefText(value: string): void {
  if (value.trim() === '') { emit('update', { kind: 'value', value: undefined }); return; }
  try {
    const parsed = Json.safeParse(JSON.parse(value));
    emit('update', { kind: 'value', value: parsed.success ? parsed.data : undefined });
  } catch {
    emit('update', { kind: 'value', value: undefined });
  }
}

const choiceValue = computed(() => (props.draft.kind === 'choice' && props.draft.index >= 0 ? String(props.draft.index) : ''));
const choiceOptions = computed(() => (props.node.kind === 'enum' ? props.node.choices.map((c, i) => ({ value: String(i), label: c.label })) : []));
const setChoice = (value: string): void => { emit('update', { kind: 'choice', index: value === '' ? -1 : Number(value) }); };

function setItem(at: number, draft: Draft): void {
  emit('update', { kind: 'items', items: items.value.map((item, i) => (i === at ? draft : item)) });
}
function addItem(): void {
  if (props.node.kind === 'list') { emit('update', { kind: 'items', items: [...items.value, draftOf(props.node.item)] }); }
}
function removeItem(at: number): void {
  emit('update', { kind: 'items', items: items.value.filter((_, i) => i !== at) });
}
function moveItem(at: number, by: number): void {
  const next = [...items.value];
  const [moved] = next.splice(at, 1);
  if (moved === undefined) { return; }
  next.splice(Math.max(0, Math.min(next.length, at + by)), 0, moved);
  emit('update', { kind: 'items', items: next });
}

function setEntry(at: number, part: 'key' | 'value', draft: Draft): void {
  emit('update', { kind: 'entries', entries: entries.value.map((e, i) => (i === at ? { ...e, [part]: draft } : e)) });
}
function addEntry(): void {
  if (props.node.kind === 'map') { emit('update', { kind: 'entries', entries: [...entries.value, { key: draftOf(props.node.key), value: draftOf(props.node.value) }] }); }
}
function removeEntry(at: number): void {
  emit('update', { kind: 'entries', entries: entries.value.filter((_, i) => i !== at) });
}

const fields = computed(() => (props.draft.kind === 'fields' ? props.draft : { kind: 'fields' as const, fields: {}, present: {} }));
function fieldDraft(name: string, node: FormNode): Draft {
  return fields.value.fields[name] ?? draftOf(node);
}
function setField(name: string, draft: Draft): void {
  emit('update', { kind: 'fields', fields: { ...fields.value.fields, [name]: draft }, present: { ...fields.value.present, [name]: true } });
}
function setPresent(name: string, present: boolean): void {
  emit('update', { kind: 'fields', fields: fields.value.fields, present: { ...fields.value.present, [name]: present } });
}

const isNull = computed(() => props.draft.kind === 'nullable' && props.draft.isNull);
const innerDraft = computed<Draft>(() => {
  if (props.draft.kind === 'nullable' || props.draft.kind === 'or') { return props.draft.value; }
  return props.node.kind === 'nullable' ? draftOf(props.node.inner) : props.draft;
});
const setNull = (value: boolean): void => { emit('update', { kind: 'nullable', isNull: value, value: innerDraft.value }); };
const setInner = (draft: Draft): void => {
  if (props.draft.kind === 'or') { emit('update', { kind: 'or', option: props.draft.option, value: draft }); return; }
  emit('update', { kind: 'nullable', isNull: false, value: draft });
};

const optionValue = computed(() => (props.draft.kind === 'or' ? String(props.draft.option) : '0'));
const unionOptions = computed(() => (props.node.kind === 'or' ? props.node.options.map((o, i) => ({ value: String(i), label: o.label })) : []));
const optionNode = computed(() => (props.node.kind === 'or' ? props.node.options[Number(optionValue.value)]?.node : undefined));
function setOption(value: string): void {
  if (props.node.kind !== 'or') { return; }
  const option = props.node.options[Number(value)];
  if (option !== undefined) { emit('update', { kind: 'or', option: Number(value), value: draftOf(option.node) }); }
}

const colorText = computed(() => (/^#[0-9a-f]{6}$/i.test(text.value) ? text.value : '#000000'));
const dateKind = computed(() => (props.node.kind === 'timestamp' ? 'datetime-local' : 'date'));
</script>

<template>
  <div class="gin-input" :class="`kind-${node.kind}`" :data-path="path" data-testid="gin-input">
    <template v-if="node.kind === 'text'">
      <UiTextarea v-if="node.multiline" :model-value="text" :label="label" :hint="hint" :error="error" :required="required" :rows="3" @update:model-value="setText" />
      <UiInput v-else :model-value="text" :label="label" :hint="hint" :error="error" :required="required" @update:model-value="setText" />
    </template>

    <UiInput v-else-if="node.kind === 'num'" :model-value="text" type="number" :label="label" :hint="hint" :error="error" :required="required" @update:model-value="setText" />
    <UiInput v-else-if="node.kind === 'duration'" :model-value="text" :label="label" :hint="hint" :error="error" :required="required" placeholder="2s" @update:model-value="setText" />

    <div v-else-if="node.kind === 'bool'" class="switch-row">
      <UiSwitch :model-value="bool" :label="label" :description="hint" @update:model-value="emit('update', { kind: 'bool', value: $event })" />
    </div>

    <UiField v-else-if="node.kind === 'enum'" v-slot="field" :label="label" :hint="hint" :error="error" :required="required">
      <UiSegmented v-if="choiceOptions.length <= 4" :model-value="choiceValue" :options="choiceOptions" :label="label" @update:model-value="setChoice" />
      <select v-else :id="field.id" class="native" :value="choiceValue" :aria-describedby="field.describedBy" :aria-invalid="field.invalid ? 'true' : undefined" @change="setChoice(eventValue($event))">
        <option value="" disabled>Choose…</option>
        <option v-for="option in choiceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </UiField>

    <UiField v-else-if="node.kind === 'date' || node.kind === 'timestamp'" v-slot="field" :label="label" :hint="hint" :error="error" :required="required">
      <input :id="field.id" class="native" :type="dateKind" :value="text" :aria-describedby="field.describedBy" :aria-invalid="field.invalid ? 'true' : undefined" @input="setText(eventValue($event))" />
    </UiField>

    <UiField v-else-if="node.kind === 'color'" v-slot="field" :label="label" :hint="hint" :error="error" :required="required">
      <div class="color">
        <input :id="field.id" class="swatch" type="color" :value="colorText" :aria-describedby="field.describedBy" @input="setText(eventValue($event))" />
        <code class="hex">{{ colorText }}</code>
      </div>
    </UiField>

    <UiTextarea v-else-if="node.kind === 'json'" class="mono" :model-value="text" :label="label" :hint="hint || 'Any JSON value'" :error="error" :rows="3" @update:model-value="setText" />

    <UiField v-else-if="node.kind === 'literal'" :label="label" :hint="hint">
      <code class="literal">{{ JSON.stringify(node.value) }}</code>
    </UiField>

    <template v-else-if="node.kind === 'ref'">
      <UiField v-if="custom" :label="label" :hint="hint" :error="error" :required="required">
        <component
          :is="custom.component" v-bind="custom.props" :model-value="draft.kind === 'value' ? draft.value : undefined" :problems="error === '' ? [] : [error]"
          @update:model-value="setCustom"
        />
      </UiField>
      <UiTextarea v-else class="mono" :model-value="refText" :label="label" :hint="hint || `A ${node.name} value, as JSON`" :error="error" :rows="3" @update:model-value="setRefText" />
    </template>

    <fieldset v-else-if="node.kind === 'list' || node.kind === 'tuple'" class="group" :aria-describedby="error === '' ? undefined : `${id}-error`">
      <legend class="legend">{{ label }}<span v-if="required" class="required" aria-hidden="true">*</span></legend>
      <p v-if="hint !== ''" class="hint">{{ hint }}</p>
      <ol class="items">
        <li v-for="(item, at) in items" :key="at" class="item">
          <GinInput
            class="grow" :node="node.kind === 'list' ? node.item : (node.elements[at] ?? node.elements[0] ?? node)" :draft="item" :path="join(at)"
            :problems="problems" :label="`${label} ${at + 1}`" flat @update="setItem(at, $event)"
          />
          <div v-if="node.kind === 'list'" class="item-actions">
            <UiIconButton icon="chevron-up" size="sm" :label="`Move ${label} ${at + 1} up`" :disabled="at === 0" @click="moveItem(at, -1)" />
            <UiIconButton icon="chevron-down" size="sm" :label="`Move ${label} ${at + 1} down`" :disabled="at === items.length - 1" @click="moveItem(at, 1)" />
            <UiIconButton icon="x" size="sm" :label="`Remove ${label} ${at + 1}`" @click="removeItem(at)" />
          </div>
        </li>
      </ol>
      <UiButton v-if="node.kind === 'list' && (node.maxLength === undefined || items.length < node.maxLength)" size="sm" variant="ghost" icon="plus" @click="addItem">Add</UiButton>
      <p v-if="error !== ''" :id="`${id}-error`" class="error">{{ error }}</p>
    </fieldset>

    <fieldset v-else-if="node.kind === 'map'" class="group">
      <legend class="legend">{{ label }}</legend>
      <p v-if="hint !== ''" class="hint">{{ hint }}</p>
      <ol class="items">
        <li v-for="(entry, at) in entries" :key="at" class="item entry">
          <GinInput class="grow" :node="node.key" :draft="entry.key" :path="`${join(at)}.key`" :problems="problems" label="Key" flat @update="setEntry(at, 'key', $event)" />
          <GinInput class="grow" :node="node.value" :draft="entry.value" :path="`${join(at)}.value`" :problems="problems" label="Value" flat @update="setEntry(at, 'value', $event)" />
          <UiIconButton class="entry-remove" icon="x" size="sm" :label="`Remove entry ${at + 1}`" @click="removeEntry(at)" />
        </li>
      </ol>
      <UiButton size="sm" variant="ghost" icon="plus" @click="addEntry">Add entry</UiButton>
    </fieldset>

    <component :is="flat || path === '' ? 'div' : 'fieldset'" v-else-if="node.kind === 'obj'" class="object" :class="{ group: !flat && path !== '' }">
      <legend v-if="!flat && path !== ''" class="legend">{{ label }}</legend>
      <p v-if="!flat && path !== '' && hint !== ''" class="hint">{{ hint }}</p>
      <template v-for="field in node.fields" :key="field.name">
        <div v-if="!field.optional || fields.present[field.name] === true" class="field" :class="{ removable: field.optional }">
          <GinInput
            class="grow" :node="field.node" :draft="fieldDraft(field.name, field.node)" :path="join(field.name)" :problems="problems"
            :label="field.label" :docs="field.docs" :required="!field.optional" @update="setField(field.name, $event)"
          />
          <UiIconButton v-if="field.optional" class="field-remove" icon="x" size="sm" :label="`Leave out ${field.label}`" @click="setPresent(field.name, false)" />
        </div>
      </template>
      <div v-if="node.fields.some((f) => f.optional && fields.present[f.name] !== true)" class="optional">
        <template v-for="field in node.fields" :key="field.name">
          <UiButton v-if="field.optional && fields.present[field.name] !== true" size="sm" variant="ghost" icon="plus" :title="field.docs" @click="setPresent(field.name, true)">{{ field.label }}</UiButton>
        </template>
      </div>
    </component>

    <div v-else-if="node.kind === 'nullable'" class="nullable">
      <UiSwitch :model-value="!isNull" :label="label" :description="isNull ? 'Not set' : hint" @update:model-value="setNull(!$event)" />
      <GinInput v-if="!isNull" :node="node.inner" :draft="innerDraft" :path="path" :problems="problems" :label="label" flat @update="setInner" />
    </div>

    <fieldset v-else-if="node.kind === 'or'" class="group">
      <legend class="legend">{{ label }}</legend>
      <p v-if="hint !== ''" class="hint">{{ hint }}</p>
      <UiSegmented :model-value="optionValue" :options="unionOptions" :label="`${label}: kind`" @update:model-value="setOption" />
      <GinInput v-if="optionNode" :node="optionNode" :draft="innerDraft" :path="path" :problems="problems" :label="label" flat @update="setInner" />
    </fieldset>
  </div>
</template>

<style scoped>
.gin-input { display: grid; gap: var(--space-2); min-width: 0; }
.group { display: grid; gap: var(--space-3); min-width: 0; margin: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); }
.legend { padding: 0 var(--space-1); font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text); }
.required { color: var(--danger); margin-left: 2px; }
.hint { margin: calc(-1 * var(--space-2)) 0 0; color: var(--text-faint); font-size: var(--text-xs); }
.error { margin: 0; color: var(--danger); font-size: var(--text-xs); }
.object { display: grid; gap: var(--space-3); min-width: 0; }
.items { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.item { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.entry { flex-wrap: wrap; }
.entry > .grow { flex: 1 1 160px; }
.grow { flex: 1; min-width: 0; }
.item-actions { display: flex; gap: 2px; padding-top: 26px; flex: none; }
.entry-remove { margin-top: 26px; }
.field { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.field-remove { margin-top: 26px; flex: none; }
.optional { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.nullable { display: grid; gap: var(--space-2); }
.switch-row { padding: var(--space-1) 0; }
.native {
  width: 100%; min-width: 0; height: var(--control); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text); font: inherit;
}
.native:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.color { display: flex; align-items: center; gap: var(--space-3); }
.swatch { width: var(--control); height: var(--control); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); }
.hex, .literal { font-family: var(--mono); font-size: var(--text-sm); color: var(--text-dim); }
.mono :deep(textarea) { font-family: var(--mono); font-size: var(--text-sm); }
</style>
