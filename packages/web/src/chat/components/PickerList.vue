<script setup lang="ts">
/**
 * The composer's picker: `@` results grouped by provider (label, hint, icon), `/` commands with their descriptions,
 * or `!` fns with theirs. It is an ARIA listbox the composer's textarea controls (`aria-activedescendant`), so arrow
 * keys and Enter work from the textarea while it is open, and only then. A command that can't run now is shown greyed,
 * with the reason in place of its description, and can't be picked. A fn row's qualified name is a `FnPill`: clicking it
 * opens the fn modal without picking the row.
 */
import { computed } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import { ICONS, UiIcon, UiSpinner, type IconName } from '../../ui/index.ts';
import { fnLabel } from '../logic/labels.ts';
import type { PickerItem } from '../state/composer.ts';

const props = defineProps<{ id: string; items: readonly PickerItem[]; active: number; loading: boolean; kind: 'mention' | 'command' | 'invoke' }>();
const emit = defineEmits<{ pick: [item: PickerItem]; hover: [index: number] }>();

const isIcon = (name: string | undefined): name is IconName => name !== undefined && name in ICONS;

interface Row { readonly item: PickerItem; readonly index: number; readonly group: string | undefined; readonly icon: IconName; readonly title: string; readonly hint: string; readonly off: boolean }

const rows = computed<Row[]>(() => props.items.map((item, index) => {
  const previous = index > 0 ? props.items[index - 1] : undefined;
  if (item.kind === 'mention') {
    const group = previous?.kind === 'mention' && previous.group === item.group ? undefined : item.group;
    return { item, index, group, icon: isIcon(item.option.icon) ? item.option.icon : 'link', title: item.option.label, hint: item.option.hint ?? '', off: false };
  }
  if (item.kind === 'command') {
    const reason = item.command.unavailable;
    return { item, index, group: undefined, icon: 'chevron-right', title: `/${item.command.name}`, hint: reason === undefined ? item.command.description : `Can't be used now: ${reason}`, off: reason !== undefined };
  }
  return { item, index, group: undefined, icon: 'fn', title: fnLabel(item.invocation.fn), hint: item.invocation.description, off: false };
}));

const empty = computed(() => (props.kind === 'mention' ? 'Nothing matches' : props.kind === 'command' ? 'No commands match' : 'No fns match'));
const title = computed(() => (props.kind === 'mention' ? 'Mention' : props.kind === 'command' ? 'Commands' : 'Run a fn'));
</script>

<template>
  <div class="picker" data-testid="composer-picker" :data-kind="kind">
    <div class="title">
      <span>{{ title }}</span>
      <UiSpinner v-if="loading" :size="12" label="Searching" />
    </div>
    <ul :id="id" class="list" role="listbox" :aria-label="title">
      <template v-for="row in rows" :key="row.item.key">
        <li v-if="row.group" class="group" role="presentation">{{ row.group }}</li>
        <li
          :id="`${id}-${row.index}`" class="option" role="option" :aria-selected="row.index === active ? 'true' : 'false'" :data-testid="`picker-${row.item.kind}`"
          :class="{ off: row.off }" :aria-disabled="row.off ? 'true' : undefined" @mousedown.prevent="row.off || emit('pick', row.item)" @mousemove="emit('hover', row.index)"
        >
          <span class="icon"><UiIcon :name="row.icon" :size="14" /></span>
          <span class="text">
            <span class="name">{{ row.title }}</span>
            <span v-if="row.hint !== ''" class="hint">{{ row.hint }}</span>
          </span>
          <span v-if="row.item.kind === 'invoke'" class="qualified" @mousedown.stop.prevent><FnPill :name="row.item.invocation.fn" :label="row.item.invocation.fn" /></span>
        </li>
      </template>
      <li v-if="!loading && rows.length === 0" class="none" role="presentation">{{ empty }}</li>
    </ul>
  </div>
</template>

<style scoped>
.picker { display: grid; max-height: min(320px, 45vh); min-height: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); animation: ui-pop-in var(--fast) var(--ease); }
.title { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-1); color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); text-transform: uppercase; letter-spacing: 0.04em; }
.list { margin: 0; padding: 0 var(--space-1) var(--space-1); overflow-y: auto; list-style: none; }
.group { padding: var(--space-2) var(--space-2) 2px; color: var(--text-faint); font-size: var(--text-xs); }
.option { display: flex; align-items: center; gap: var(--space-3); min-height: 40px; padding: var(--space-1) var(--space-2); border-radius: var(--radius); cursor: pointer; }
.option[aria-selected='true'] { background: var(--accent-soft); }
.option.off { cursor: default; }
.option.off .name, .option.off .icon { opacity: 0.55; }
.option.off[aria-selected='true'] { background: var(--surface-2); }
.option.off[aria-selected='true'] .icon { background: var(--surface-3); color: var(--text-dim); }
.icon { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-dim); }
.option[aria-selected='true'] .icon { background: var(--accent); color: var(--on-accent); }
.text { display: grid; flex: 1; min-width: 0; }
.name { font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { color: var(--text-faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qualified { flex: none; max-width: 40%; font-family: var(--mono); font-size: var(--text-xs); }
.qualified :deep(.fn-pill) { font-size: var(--text-xs); }
.none { padding: var(--space-3); color: var(--text-faint); font-size: var(--text-sm); }
@media (max-width: 480px) { .qualified { display: none; } }
</style>
