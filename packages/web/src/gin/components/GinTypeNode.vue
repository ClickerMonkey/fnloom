<script setup lang="ts">
/**
 * One node of a gin type, viewed or edited. Viewing draws its kind, its constraints and docs, and its children as a
 * tree (an object's fields with their optional mark and docs, a list's item, a union's options). Editing adds a kind
 * picker, the options of the kind (lengths, ranges, a pattern, whole numbers, enum values, a literal's value, a named
 * type's name), the docs, and the children's own editors with add, remove, rename and reorder. It emits each changed
 * shape; the type view checks it with gin.
 */
import type { ListOptions, NumOptions, TextOptions } from '@aeye/gin';
import { computed } from 'vue';
import { UiBadge, UiButton, UiIconButton, UiInput, UiSegmented, UiSelect, UiSwitch, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import {
  blankShape, boundOf, boundText, changeKind, constraintText, freshName, kindLabel, literalAs, literalKind, moveAt, PICKABLE_KINDS, removeAt, replaceAt,
  withOption, type FieldShape, type LiteralKind, type PickableKind, type ShapeProblem, type TypeShape,
} from '../logic/typedef.ts';

const props = withDefaults(defineProps<{
  shape: TypeShape;
  readonly?: boolean;
  /** What holds this node (`Field path`, `Item`), for labels and screen readers. */
  label?: string;
  /** Where the node is in the type (`fields.path`), for its problems. */
  path?: string;
  problems?: readonly ShapeProblem[];
}>(), { readonly: false, label: 'Type', path: '', problems: () => [] });

const emit = defineEmits<{ update: [shape: TypeShape] }>();

const KIND_OPTIONS: readonly SelectOption<PickableKind>[] = PICKABLE_KINDS.map((k) => ({ value: k.kind, label: k.label }));
const LITERAL_KINDS: readonly SegmentOption<LiteralKind>[] = [{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'bool', label: 'Yes or no' }];
/** The node's kind when it is one a person can choose (the kind picker shows it). */
const pickedKind = computed<PickableKind | undefined>(() => PICKABLE_KINDS.find((k) => k.kind === props.shape.kind)?.kind);
const own = computed(() => props.problems.filter((p) => p.path === props.path).map((p) => p.message));
const constraints = computed(() => constraintText(props.shape));
const at = (key: string | number): string => (props.path === '' ? String(key) : `${props.path}.${key}`);

function pick(kind: PickableKind): void {
  emit('update', changeKind(props.shape, kind));
}
function setDocs(docs: string): void {
  emit('update', { ...props.shape, docs });
}

function setText<K extends keyof TextOptions>(key: K, value: Exclude<TextOptions[K], undefined> | undefined): void {
  if (props.shape.kind === 'text') { emit('update', { ...props.shape, options: withOption(props.shape.options, key, value) }); }
}
function setNum<K extends keyof NumOptions>(key: K, value: Exclude<NumOptions[K], undefined> | undefined): void {
  if (props.shape.kind === 'num') { emit('update', { ...props.shape, options: withOption(props.shape.options, key, value) }); }
}
function setList<K extends keyof ListOptions>(key: K, value: Exclude<ListOptions[K], undefined> | undefined): void {
  if (props.shape.kind === 'list') { emit('update', { ...props.shape, options: withOption(props.shape.options, key, value) }); }
}
function setAlpha(on: boolean): void {
  if (props.shape.kind === 'color') { emit('update', { ...props.shape, options: withOption(props.shape.options, 'hasAlpha', on ? true : undefined) }); }
}
function setName(name: string): void {
  if (props.shape.kind === 'ref' || props.shape.kind === 'named') { emit('update', { ...props.shape, name }); }
}
function setLiteral(value: string | number | boolean): void {
  if (props.shape.kind === 'literal') { emit('update', { ...props.shape, value }); }
}

/** The one child slot a node has (a list's item, a map's key or value, a wrapper's inner, a named type's base). */
type Slot = 'item' | 'key' | 'value' | 'inner' | 'base';
function setChild(slot: Slot, child: TypeShape): void {
  const shape = props.shape;
  if (slot === 'item' && shape.kind === 'list') { emit('update', { ...shape, item: child }); }
  if ((slot === 'key' || slot === 'value') && shape.kind === 'map') { emit('update', slot === 'key' ? { ...shape, key: child } : { ...shape, value: child }); }
  if (slot === 'inner' && (shape.kind === 'optional' || shape.kind === 'nullable')) { emit('update', { ...shape, inner: child }); }
  if (slot === 'base' && shape.kind === 'named') { emit('update', { ...shape, base: child }); }
}
function removeEnumValue(index: number): void {
  if (props.shape.kind === 'enum') { emit('update', { ...props.shape, values: removeAt(props.shape.values, index) }); }
}

function setField(index: number, field: FieldShape): void {
  if (props.shape.kind === 'obj') { emit('update', { ...props.shape, fields: replaceAt(props.shape.fields, index, field) }); }
}
function addField(): void {
  if (props.shape.kind !== 'obj') { return; }
  const name = freshName(props.shape.fields.map((f) => f.name));
  emit('update', { ...props.shape, fields: [...props.shape.fields, { name, docs: '', optional: false, type: blankShape('text') }] });
}
function removeField(index: number): void {
  if (props.shape.kind === 'obj') { emit('update', { ...props.shape, fields: removeAt(props.shape.fields, index) }); }
}
function moveField(index: number, by: number): void {
  if (props.shape.kind === 'obj') { emit('update', { ...props.shape, fields: moveAt(props.shape.fields, index, by) }); }
}

/** The list of child types a tuple or a union holds. */
const members = computed<readonly TypeShape[]>(() => (props.shape.kind === 'tuple' ? props.shape.elements : props.shape.kind === 'or' ? props.shape.variants : []));
function setMembers(next: readonly TypeShape[]): void {
  if (props.shape.kind === 'tuple') { emit('update', { ...props.shape, elements: next }); }
  if (props.shape.kind === 'or') { emit('update', { ...props.shape, variants: next }); }
}

function setEnumLabel(index: number, label: string): void {
  if (props.shape.kind !== 'enum') { return; }
  const value = props.shape.values[index]?.value;
  emit('update', { ...props.shape, values: replaceAt(props.shape.values, index, { label, value: typeof value === 'number' ? value : label }) });
}
function addEnumValue(): void {
  if (props.shape.kind !== 'enum') { return; }
  const label = freshName(props.shape.values.map((v) => v.label), 'value');
  emit('update', { ...props.shape, values: [...props.shape.values, { label, value: label }] });
}
</script>

<template>
  <div class="gin-type-node" :class="[`kind-${shape.kind}`, { readonly }]" :data-path="path" data-testid="gin-type-node">
    <div class="head">
      <UiSelect
        v-if="!readonly && pickedKind !== undefined" class="kind" :model-value="pickedKind" :options="KIND_OPTIONS" :label="`${label}: kind`" hide-label size="sm"
        @update:model-value="pick($event)"
      />
      <UiBadge v-else tone="accent">{{ kindLabel(shape.kind) }}</UiBadge>
      <code v-if="shape.kind === 'ref' && readonly" class="name">{{ shape.name }}</code>
      <code v-if="shape.kind === 'named'" class="name">{{ shape.name }}</code>
      <span v-if="readonly && constraints !== ''" class="constraints">{{ constraints }}</span>
    </div>
    <p v-if="readonly && shape.docs !== ''" class="docs">{{ shape.docs }}</p>
    <UiInput v-if="!readonly" :model-value="shape.docs" :label="`${label}: docs`" hide-label placeholder="What it is (docs)" size="sm" @update:model-value="setDocs" />
    <p v-for="message in own" :key="message" class="problem" role="alert">{{ message }}</p>

    <!-- options of the kind -->
    <div v-if="!readonly && shape.kind === 'text'" class="options">
      <UiInput :model-value="boundText(shape.options.minLength)" type="number" label="At least" size="sm" @update:model-value="setText('minLength', boundOf($event))" />
      <UiInput :model-value="boundText(shape.options.maxLength)" type="number" label="At most" size="sm" @update:model-value="setText('maxLength', boundOf($event))" />
      <UiInput :model-value="shape.options.pattern ?? ''" label="Pattern" placeholder="^[a-z]+$" size="sm" @update:model-value="setText('pattern', $event === '' ? undefined : $event)" />
    </div>
    <div v-else-if="!readonly && shape.kind === 'num'" class="options">
      <UiInput :model-value="boundText(shape.options.min)" type="number" label="Smallest" size="sm" @update:model-value="setNum('min', boundOf($event))" />
      <UiInput :model-value="boundText(shape.options.max)" type="number" label="Largest" size="sm" @update:model-value="setNum('max', boundOf($event))" />
      <UiSwitch :model-value="shape.options.whole === true" label="Whole numbers" @update:model-value="setNum('whole', $event ? true : undefined)" />
    </div>
    <div v-else-if="!readonly && shape.kind === 'list'" class="options">
      <UiInput :model-value="boundText(shape.options.minLength)" type="number" label="At least" size="sm" @update:model-value="setList('minLength', boundOf($event))" />
      <UiInput :model-value="boundText(shape.options.maxLength)" type="number" label="At most" size="sm" @update:model-value="setList('maxLength', boundOf($event))" />
    </div>
    <div v-else-if="!readonly && shape.kind === 'color'" class="options">
      <UiSwitch :model-value="shape.options.hasAlpha === true" label="With alpha" @update:model-value="setAlpha($event)" />
    </div>
    <div v-else-if="!readonly && (shape.kind === 'ref' || shape.kind === 'named')" class="options">
      <UiInput :model-value="shape.name" label="Type name" placeholder="fs/Entry" size="sm" @update:model-value="setName" />
    </div>
    <div v-else-if="!readonly && shape.kind === 'literal'" class="options">
      <UiSegmented :model-value="literalKind(shape.value)" :options="LITERAL_KINDS" :label="`${label}: literal kind`" @update:model-value="setLiteral(literalAs(shape.value, $event))" />
      <UiSwitch v-if="typeof shape.value === 'boolean'" :model-value="shape.value" label="Value" @update:model-value="setLiteral" />
      <UiInput
        v-else :model-value="String(shape.value)" :type="typeof shape.value === 'number' ? 'number' : 'text'" label="Value" size="sm"
        @update:model-value="setLiteral(literalAs($event, literalKind(shape.value)))"
      />
    </div>
    <div v-else-if="shape.kind === 'enum'" class="enum">
      <template v-if="readonly">
        <UiBadge v-for="value in shape.values" :key="value.label">{{ value.label }}<template v-if="value.value !== value.label"> = {{ value.value }}</template></UiBadge>
      </template>
      <template v-else>
        <div v-for="(value, index) in shape.values" :key="index" class="enum-row">
          <UiInput :model-value="value.label" :label="`Value ${index + 1}`" hide-label size="sm" @update:model-value="setEnumLabel(index, $event)" />
          <UiIconButton icon="x" size="sm" :label="`Remove ${value.label}`" @click="removeEnumValue(index)" />
        </div>
        <UiButton size="sm" variant="ghost" icon="plus" @click="addEnumValue">Add value</UiButton>
      </template>
    </div>
    <pre v-else-if="shape.kind === 'other'" class="code">{{ shape.code }}</pre>

    <!-- children -->
    <div v-if="shape.kind === 'list'" class="children">
      <span class="child-label">Each item</span>
      <GinTypeNode :shape="shape.item" :readonly="readonly" :label="`${label} item`" :path="at('item')" :problems="problems" @update="setChild('item', $event)" />
    </div>
    <div v-else-if="shape.kind === 'map'" class="children">
      <span class="child-label">Keys</span>
      <GinTypeNode :shape="shape.key" :readonly="readonly" :label="`${label} key`" :path="at('key')" :problems="problems" @update="setChild('key', $event)" />
      <span class="child-label">Values</span>
      <GinTypeNode :shape="shape.value" :readonly="readonly" :label="`${label} value`" :path="at('value')" :problems="problems" @update="setChild('value', $event)" />
    </div>
    <div v-else-if="shape.kind === 'optional' || shape.kind === 'nullable'" class="children">
      <span class="child-label">{{ shape.kind === 'optional' ? 'When set' : 'When not null' }}</span>
      <GinTypeNode :shape="shape.inner" :readonly="readonly" :label="`${label} inner`" :path="at('inner')" :problems="problems" @update="setChild('inner', $event)" />
    </div>
    <div v-else-if="shape.kind === 'named'" class="children">
      <span class="child-label">Extends</span>
      <GinTypeNode :shape="shape.base" :readonly="readonly" :label="`${label} base`" :path="at('base')" :problems="problems" @update="setChild('base', $event)" />
    </div>
    <ol v-else-if="shape.kind === 'tuple' || shape.kind === 'or'" class="children members">
      <li v-for="(member, index) in members" :key="index" class="member">
        <div class="member-head">
          <span class="child-label">{{ shape.kind === 'tuple' ? `Position ${index + 1}` : `Option ${index + 1}` }}</span>
          <UiIconButton v-if="!readonly && members.length > 1" icon="x" size="sm" :label="`Remove ${shape.kind === 'tuple' ? 'position' : 'option'} ${index + 1}`" @click="setMembers(removeAt(members, index))" />
        </div>
        <GinTypeNode :shape="member" :readonly="readonly" :label="`${label} ${index + 1}`" :path="at(index)" :problems="problems" @update="setMembers(replaceAt(members, index, $event))" />
      </li>
      <li v-if="!readonly"><UiButton size="sm" variant="ghost" icon="plus" @click="setMembers([...members, blankShape('text')])">{{ shape.kind === 'tuple' ? 'Add position' : 'Add option' }}</UiButton></li>
    </ol>
    <ol v-else-if="shape.kind === 'obj'" class="children fields" data-testid="gin-type-fields">
      <li v-for="(field, index) in shape.fields" :key="index" class="field" :data-field="field.name">
        <div class="field-head">
          <template v-if="readonly">
            <code class="field-name">{{ field.name }}<span v-if="field.optional" class="optional" title="May be left out">?</span></code>
            <span v-if="field.docs !== ''" class="field-docs">{{ field.docs }}</span>
          </template>
          <template v-else>
            <UiInput class="field-name-input" :model-value="field.name" :label="`Field ${index + 1} name`" hide-label size="sm" @update:model-value="setField(index, { ...field, name: $event })" />
            <UiSwitch :model-value="field.optional" label="Optional" @update:model-value="setField(index, { ...field, optional: $event })" />
            <span class="field-tools">
              <UiIconButton icon="chevron-up" size="sm" :label="`Move ${field.name} up`" :disabled="index === 0" @click="moveField(index, -1)" />
              <UiIconButton icon="chevron-down" size="sm" :label="`Move ${field.name} down`" :disabled="index === shape.fields.length - 1" @click="moveField(index, 1)" />
              <UiIconButton icon="x" size="sm" :label="`Remove ${field.name}`" @click="removeField(index)" />
            </span>
          </template>
        </div>
        <UiInput v-if="!readonly" :model-value="field.docs" :label="`${field.name} docs`" hide-label placeholder="What the field is" size="sm" @update:model-value="setField(index, { ...field, docs: $event })" />
        <GinTypeNode :shape="field.type" :readonly="readonly" :label="field.name" :path="at(field.name)" :problems="problems" @update="setField(index, { ...field, type: $event })" />
      </li>
      <li v-if="shape.fields.length === 0" class="empty">No fields</li>
      <li v-if="!readonly"><UiButton size="sm" variant="ghost" icon="plus" data-testid="gin-type-add-field" @click="addField">Add field</UiButton></li>
    </ol>
  </div>
</template>

<style scoped>
.gin-type-node { display: grid; gap: var(--space-2); min-width: 0; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
.kind { width: min(100%, 200px); }
.name { font: var(--text-sm) var(--mono); color: var(--text); overflow-wrap: anywhere; }
.constraints { color: var(--text-faint); font-size: var(--text-xs); }
.docs { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-xs); }
.options { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-2); align-items: end; }
.enum { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.enum-row { display: flex; align-items: center; gap: var(--space-1); flex: 1 1 180px; min-width: 0; }
.enum-row > :first-child { flex: 1; min-width: 0; }
.code { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--code-bg); font: var(--text-xs) var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.children { display: grid; gap: var(--space-2); margin: 0; padding: 0 0 0 var(--space-3); border-left: 2px solid var(--border); list-style: none; min-width: 0; }
.child-label { color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.member, .field { display: grid; gap: var(--space-2); min-width: 0; }
.member-head, .field-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
.field + .field, .member + .member { padding-top: var(--space-2); border-top: 1px dashed var(--border); }
.field-name { font: var(--weight-medium) var(--text-sm) var(--mono); color: var(--text); }
.optional { color: var(--text-faint); }
.field-docs { color: var(--text-dim); font-size: var(--text-xs); }
.field-name-input { flex: 1 1 160px; min-width: 0; }
.field-tools { display: flex; gap: 2px; margin-left: auto; }
.empty { color: var(--text-faint); font-size: var(--text-sm); }
</style>
