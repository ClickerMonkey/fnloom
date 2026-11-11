<script setup lang="ts">
/**
 * Resources as a list: a row each with a checkbox, its type's icon, its name and address, its forms as badges, its
 * size, when it changed and where it came from, and its menu. On wide screens the columns sort from their headers;
 * on phones a row is two lines. The opened row is marked. A click anywhere on a row opens it (its name button covers
 * the row), except on its checkbox and menu.
 */
import type { ResourceRecord, ResourceUri } from '@harness/core';
import { UiBadge, UiIcon, relativeTime } from '../../ui/index.ts';
import { formatBytes } from '../../chat/logic/format.ts';
import type { ResourceAction } from '../logic/actions.ts';
import { nameOf, shortAddress, type BrowserSort } from '../logic/browse.ts';
import { BADGE_FORMS, FAMILY_ICON, FORM_LABEL, familyOfStat, typeWord } from '../logic/formats.ts';
import ResourceMenu from './ResourceMenu.vue';

withDefaults(defineProps<{
  records: readonly ResourceRecord[];
  selected: ReadonlySet<ResourceUri>;
  opened?: string;
  sort: BrowserSort;
  descending: boolean;
  now: number;
}>(), { opened: '' });

const emit = defineEmits<{ open: [uri: ResourceUri]; toggle: [uri: ResourceUri]; toggleAll: []; sort: [sort: BrowserSort]; action: [action: ResourceAction, record: ResourceRecord] }>();

const COLUMNS: readonly { readonly sort: BrowserSort; readonly label: string; readonly class: string }[] = [
  { sort: 'name', label: 'Name', class: 'c-name' }, { sort: 'type', label: 'Type', class: 'c-type' }, { sort: 'size', label: 'Size', class: 'c-size' },
  { sort: 'modified', label: 'Changed', class: 'c-time' },
];
const badges = (record: ResourceRecord): string[] => BADGE_FORMS.filter((kind) => record.forms?.includes(kind) === true).map((kind) => FORM_LABEL[kind]);
</script>

<template>
  <div class="resource-list" data-testid="resource-list">
    <div class="head" role="row">
      <label class="check"><input type="checkbox" :checked="records.length > 0 && records.every((r) => selected.has(r.uri))" aria-label="Select every resource shown" @change="emit('toggleAll')" /></label>
      <span class="c-icon" aria-hidden="true"></span>
      <button v-for="column in COLUMNS" :key="column.sort" type="button" class="sorter" :class="[column.class, { active: sort === column.sort }]" :aria-pressed="sort === column.sort" @click="emit('sort', column.sort)">
        {{ column.label }}<UiIcon v-if="sort === column.sort" :name="descending ? 'chevron-down' : 'chevron-up'" :size="12" />
      </button>
      <span class="c-menu" aria-hidden="true"></span>
    </div>
    <ul class="rows" aria-label="Resources">
      <li v-for="record in records" :key="record.uri" class="row" :class="{ opened: opened === record.uri, selected: selected.has(record.uri) }" :data-uri="record.uri" data-testid="resource-row">
        <label class="check"><input type="checkbox" :checked="selected.has(record.uri)" :aria-label="`Select ${nameOf(record)}`" @change="emit('toggle', record.uri)" /></label>
        <UiIcon class="c-icon" :name="FAMILY_ICON[familyOfStat(record.stat)]" :size="18" />
        <button type="button" class="c-name open" :aria-current="opened === record.uri ? 'true' : undefined" @click="emit('open', record.uri)">
          <span class="name">{{ nameOf(record) }}</span>
          <span class="uri" :title="record.uri">{{ shortAddress(record.uri) }}</span>
          <span v-if="badges(record).length > 0" class="badges"><UiBadge v-for="label in badges(record)" :key="label" tone="accent">{{ label }}</UiBadge></span>
        </button>
        <span class="c-type">{{ typeWord(record.stat) }}<span class="system"> · {{ record.system }}</span></span>
        <span class="c-size">{{ record.stat.size === undefined ? '—' : formatBytes(record.stat.size) }}</span>
        <span class="c-time">{{ relativeTime(record.stat.modifiedAt ?? record.seenAt, now) }}</span>
        <ResourceMenu class="c-menu" :record="record" @select="emit('action', $event, record)" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.resource-list { min-width: 0; container: list / inline-size; }
.head, .row { display: grid; grid-template-columns: 28px 24px minmax(0, 1fr) 140px 84px 104px 36px; align-items: center; gap: var(--space-2); padding: 0 var(--space-2); }
.head { min-height: 32px; border-bottom: 1px solid var(--border); color: var(--text-faint); font-size: var(--text-xs); }
.sorter { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sorter.active { color: var(--text); font-weight: var(--weight-medium); }
.sorter:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 4px; }
.rows { margin: 0; padding: 0; list-style: none; }
.row { position: relative; min-height: 52px; border-bottom: 1px solid var(--border); cursor: pointer; }
/* the name button's hit area is the whole row; the checkbox and menu sit above it */
.open::after { content: ""; position: absolute; inset: 0; }
.row > .check, .row > .c-menu { position: relative; z-index: 1; }
.row:hover { background: var(--surface-2); }
.row.opened { background: color-mix(in oklab, var(--accent) 10%, transparent); }
.row.selected { background: color-mix(in oklab, var(--accent) 6%, transparent); }
.check { display: grid; place-items: center; }
.check input { width: 16px; height: 16px; accent-color: var(--accent); }
.c-icon { color: var(--text-dim); }
.open { display: grid; gap: 2px; min-width: 0; padding: var(--space-2) 0; border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.open:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 6px; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
.uri { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: var(--text-xs) var(--mono); }
.badges { display: flex; flex-wrap: wrap; gap: 4px; }
.c-type, .c-size, .c-time { color: var(--text-dim); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-size { text-align: right; font-variant-numeric: tabular-nums; }
.head .c-size { justify-content: flex-end; }
@container list (max-width: 640px) {
  .head { display: none; }
  .row { grid-template-columns: 28px 24px minmax(0, 1fr) 36px; grid-template-areas: 'check icon name menu' 'check icon meta menu'; row-gap: 0; padding-block: var(--space-1); }
  .row > .check { grid-area: check; }
  .row > .c-icon { grid-area: icon; }
  .row > .c-name { grid-area: name; padding-bottom: 0; }
  .row > .c-menu { grid-area: menu; }
  .row > .c-type { grid-area: meta; }
  .row > .c-size, .row > .c-time { display: none; }
  .system { display: none; }
}
</style>
