<script setup lang="ts" generic="V extends string">
/**
 * A menu of actions opened from a trigger (the `trigger` slot, given `toggle`, `open` and the ARIA attributes to bind).
 * Arrow keys, Home and End move between actions, a letter jumps to the next action starting with it, Enter chooses,
 * Escape and Tab close. Choosing emits `select` with the action's value.
 */
import { nextTick, ref } from 'vue';
import UiIcon from './UiIcon.vue';
import UiPopover from './UiPopover.vue';
import { moveIndex } from './keys.ts';
import type { Align, Side } from './floating.ts';
import type { MenuAction, MenuItem } from './types.ts';

const props = withDefaults(defineProps<{
  items: readonly MenuItem<V>[];
  label: string;
  side?: Side;
  align?: Align;
}>(), { side: 'bottom', align: 'end' });

const emit = defineEmits<{ select: [value: V] }>();
const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);

const isAction = (item: MenuItem<V>): item is MenuAction<V> => item.kind !== 'separator';

function actionElements(): HTMLElement[] {
  return Array.from(list.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

function actions(): MenuAction<V>[] {
  return props.items.filter(isAction);
}

async function show(focus: 'first' | 'last'): Promise<void> {
  open.value = true;
  await nextTick();
  await nextTick();
  const elements = actionElements();
  const all = actions();
  const order = focus === 'first' ? all.map((_, i) => i) : all.map((_, i) => all.length - 1 - i);
  const at = order.find((i) => all[i]?.disabled !== true);
  if (at !== undefined) { elements[at]?.focus(); }
}

function toggle(): void {
  if (open.value) { open.value = false; } else { void show('first'); }
}

function onTriggerKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void show(event.key === 'ArrowDown' ? 'first' : 'last');
  }
}

function choose(item: MenuAction<V>): void {
  if (item.disabled === true) { return; }
  open.value = false;
  emit('select', item.value);
}

function onListKey(event: KeyboardEvent): void {
  const elements = actionElements();
  const all = actions();
  const current = elements.findIndex((el) => el === document.activeElement);
  if (event.key === 'Tab') { open.value = false; return; }
  const moved = moveIndex(event.key, current, elements.length, 'vertical', (at) => all[at]?.disabled === true);
  if (moved !== undefined) {
    event.preventDefault();
    elements[moved]?.focus();
    return;
  }
  if (event.key.length === 1 && /\S/.test(event.key)) {
    const letter = event.key.toLowerCase();
    const count = all.length;
    for (let step = 1; step <= count; step++) {
      const at = (current + step) % count;
      const item = all[at];
      if (item && item.disabled !== true && item.label.toLowerCase().startsWith(letter)) {
        elements[at]?.focus();
        break;
      }
    }
  }
}

defineSlots<{ trigger: (props: { toggle: () => void; open: boolean; attrs: { 'aria-haspopup': 'menu'; 'aria-expanded': 'true' | 'false' } }) => unknown }>();
</script>

<template>
  <span ref="anchor" class="ui-menu-trigger" @keydown="onTriggerKey">
    <slot name="trigger" :toggle="toggle" :open="open" :attrs="{ 'aria-haspopup': 'menu', 'aria-expanded': open ? 'true' : 'false' }" />
  </span>
  <UiPopover v-model:open="open" :anchor="anchor" :side="side" :align="align" role="menu" :label="label" :take-focus="false">
    <div ref="list" class="ui-menu" @keydown="onListKey">
      <template v-for="(item, index) in items" :key="index">
        <div v-if="item.kind === 'separator'" class="separator" role="separator" />
        <button
          v-else type="button" role="menuitem" class="item" :class="{ danger: item.danger }" tabindex="-1" :data-value="item.value"
          :aria-disabled="item.disabled === true ? 'true' : undefined" @click="choose(item)"
        >
          <UiIcon v-if="item.icon" :name="item.icon" :size="16" class="icon" />
          <span class="text">{{ item.label }}</span>
          <span v-if="item.hint" class="hint">{{ item.hint }}</span>
        </button>
      </template>
    </div>
  </UiPopover>
</template>

<style scoped>
.ui-menu-trigger { display: inline-flex; }
.ui-menu { display: grid; padding: var(--space-1); min-width: 180px; }
.item {
  display: flex; align-items: center; gap: var(--space-3); min-height: 36px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--text); text-align: left; white-space: nowrap; font-size: var(--text-md);
  transition: background-color var(--fast) var(--ease);
}
.item:hover, .item:focus { background: var(--surface-2); outline: none; }
.item:focus-visible { box-shadow: inset 0 0 0 2px var(--accent-soft-strong); }
.item[aria-disabled='true'] { opacity: 0.45; cursor: default; }
.item.danger { color: var(--danger); }
.item.danger:hover, .item.danger:focus { background: var(--danger-soft); }
.icon { color: var(--text-dim); }
.danger .icon { color: inherit; }
.text { flex: 1; }
.hint { color: var(--text-faint); font-size: var(--text-xs); font-family: var(--mono); }
.separator { height: 1px; margin: var(--space-1) var(--space-2); background: var(--border); }
</style>
