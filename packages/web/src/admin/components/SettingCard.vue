<script setup lang="ts">
/**
 * One actor setting a system declared: what it controls, who it can be set on and how values combine, and the value
 * on each actor that has one. Each value opens for editing; Set adds one for another actor.
 */
import type { ActorId, SettingMerge } from '@harness/core';
import { argSummary } from '../../chat/logic/runs.ts';
import { UiBadge, UiButton, UiIconButton, fullTime, relativeTime } from '../../ui/index.ts';
import type { NameOf } from '../logic/limits.ts';
import { ACTOR_KIND_WORDS } from '../logic/policies.ts';
import type { SettingEntry } from '../state/settings.ts';

defineProps<{ entry: SettingEntry; nameOf: NameOf; now: number }>();
const emit = defineEmits<{ edit: [actor: ActorId | undefined] }>();

const MERGE = { 'user-wins': "The person's own value wins", union: 'Values add up', intersect: 'Only what all allow', 'most-restrictive': 'The strictest wins' } as const satisfies Record<SettingMerge, string>;
</script>

<template>
  <article class="setting" :data-testid="`setting-${entry.view.setting}`">
    <header class="head">
      <div class="titles">
        <h3 class="title">{{ entry.view.decl.name }} <code class="name">{{ entry.view.setting }}</code></h3>
        <p class="description">{{ entry.view.decl.description }}</p>
        <p class="chips">
          <UiBadge>On {{ entry.view.decl.appliesTo.map((k) => ACTOR_KIND_WORDS[k].plural).join(', ') }}</UiBadge>
          <UiBadge>{{ MERGE[entry.view.decl.merge] }}</UiBadge>
        </p>
      </div>
      <UiButton icon="plus" size="sm" data-testid="setting-add" @click="emit('edit', undefined)">Set</UiButton>
    </header>
    <ul v-if="entry.values.length > 0" class="values">
      <li v-for="value in entry.values" :key="value.actor" class="value">
        <span class="who">{{ nameOf(value.actor) }}</span>
        <code class="what">{{ argSummary(value.value, 80) }}</code>
        <time class="when" :title="fullTime(value.updatedAt)">{{ relativeTime(value.updatedAt, now) }}</time>
        <UiIconButton icon="edit" size="sm" :label="`Edit for ${nameOf(value.actor)}`" @click="emit('edit', value.actor)" />
      </li>
    </ul>
    <p v-else class="none">Not set on anyone yet; systems use their own default.</p>
  </article>
</template>

<style scoped>
.setting { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.titles { display: grid; gap: var(--space-1); min-width: 0; }
.title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.name { color: var(--text-faint); font-size: var(--text-xs); font-weight: normal; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; }
.values { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); list-style: none; overflow: hidden; }
.value { display: grid; grid-template-columns: minmax(80px, 160px) minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3); }
.value + .value { border-top: 1px solid var(--border); }
.who { overflow: hidden; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.what { overflow: hidden; color: var(--text-dim); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.when { color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.none { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
@media (max-width: 559.98px) {
  .value { grid-template-columns: minmax(0, 1fr) auto; }
  .what { grid-column: 1; grid-row: 2; }
  .when { grid-column: 2; grid-row: 1; }
  .value :deep(.ui-icon-button) { grid-column: 2; grid-row: 2; justify-self: end; }
}
</style>
