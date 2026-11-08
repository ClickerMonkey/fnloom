<script setup lang="ts">
/**
 * A resource as a grid card: its thumbnail (the thumbnail form, or the image itself, drawn lazily), else its first
 * lines, else its type's glyph; then its name, type and size, its forms, a checkbox and its menu. The card size
 * comes from the grid.
 */
import type { ResourceRecord } from '@harness/core';
import { computed } from 'vue';
import { formatBytes } from '../../chat/logic/format.ts';
import { UiBadge, UiIcon } from '../../ui/index.ts';
import type { ResourceAction } from '../logic/actions.ts';
import { nameOf } from '../logic/browse.ts';
import { BADGE_FORMS, FAMILY_ICON, FORM_LABEL, familyOfStat } from '../logic/formats.ts';
import type { Peek } from '../state/browser.ts';
import ResourceMenu from './ResourceMenu.vue';

const props = withDefaults(defineProps<{ record: ResourceRecord; peek: Peek | undefined; selected?: boolean; opened?: boolean }>(), { selected: false, opened: false });
const emit = defineEmits<{ open: []; toggle: []; action: [action: ResourceAction] }>();

const family = computed(() => familyOfStat(props.record.stat));
const badges = computed(() => BADGE_FORMS.filter((kind) => props.record.forms?.includes(kind) === true).map((kind) => FORM_LABEL[kind]));
</script>

<template>
  <article class="resource-card" :class="{ selected, opened }" :data-uri="record.uri" data-testid="resource-card">
    <button type="button" class="thumb" :class="`family-${family}`" :aria-label="`Open ${nameOf(record)}`" @click="emit('open')">
      <img v-if="peek?.kind === 'image'" :src="peek.url" :alt="nameOf(record)" loading="lazy" decoding="async" />
      <pre v-else-if="peek?.kind === 'text'" class="lines">{{ peek.text }}</pre>
      <UiIcon v-else :name="FAMILY_ICON[family]" :size="40" class="glyph" />
    </button>
    <div class="meta">
      <label class="check"><input type="checkbox" :checked="selected" :aria-label="`Select ${nameOf(record)}`" @change="emit('toggle')" /></label>
      <div class="titles">
        <span class="name" :title="record.uri">{{ nameOf(record) }}</span>
        <span class="detail">{{ record.stat.format ?? record.stat.type }}<template v-if="record.stat.size !== undefined"> · {{ formatBytes(record.stat.size) }}</template></span>
      </div>
      <ResourceMenu :record="record" @select="emit('action', $event)" />
    </div>
    <div v-if="badges.length > 0" class="badges"><UiBadge v-for="label in badges" :key="label" tone="accent">{{ label }}</UiBadge></div>
  </article>
</template>

<style scoped>
.resource-card { position: relative; display: grid; grid-template-rows: auto auto; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg, var(--radius)); background: var(--surface); overflow: hidden; }
.resource-card.selected { border-color: color-mix(in oklab, var(--accent) 50%, var(--border)); }
.resource-card.opened { box-shadow: 0 0 0 2px var(--accent); }
.thumb { display: grid; place-items: center; aspect-ratio: 4 / 3; width: 100%; padding: 0; border: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--text-faint); cursor: pointer; overflow: hidden; }
.thumb:focus-visible { outline: none; box-shadow: inset var(--ring); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.family-image .thumb img, .thumb.family-image img { object-fit: contain; }
.lines { align-self: stretch; justify-self: stretch; margin: 0; padding: var(--space-2) var(--space-3); overflow: hidden; color: var(--text-dim); font: 10px/1.45 var(--mono); text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; mask-image: linear-gradient(to bottom, #000 65%, transparent); }
.meta { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: var(--space-1); padding: var(--space-2) var(--space-1) var(--space-2) var(--space-2); }
.check { display: grid; place-items: center; }
.check input { width: 16px; height: 16px; accent-color: var(--accent); }
.titles { display: grid; min-width: 0; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font-size: var(--text-xs); }
/* over the thumbnail's corner, so every card in a row is the same height */
.badges { position: absolute; top: var(--space-2); left: var(--space-2); right: var(--space-2); display: flex; flex-wrap: wrap; gap: 4px; pointer-events: none; }
.badges > * { background: linear-gradient(var(--accent-soft), var(--accent-soft)), var(--surface); box-shadow: var(--shadow-sm); }
</style>
