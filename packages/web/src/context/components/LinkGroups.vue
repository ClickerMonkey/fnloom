<script setup lang="ts">
/**
 * An item's links one way: out (what it links to) or in (what links to it), grouped by relation in plain words,
 * strongest first. Each link shows what it points at (a link to its page when it has one), its weight as a bar, and
 * where it came from; links a person drew can be removed from the item they start at. With none, a quiet line says so.
 */
import type { ContextLink, LinkTarget } from '@harness/core';
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { UiIcon, UiIconButton } from '../../ui/index.ts';
import { groupLinks, linkKey, RELATION_WORDS, removable, SOURCE_WORDS, TARGET_WORDS, targetText, weightPercent } from '../logic/context.ts';

const props = withDefaults(defineProps<{
  links: readonly ContextLink[];
  /** `out`: the item's own links (by target); `in`: links to the item (by the item they start at). */
  direction: 'out' | 'in';
  /** Where a target opens, if it has a page. */
  routeOf: (target: LinkTarget) => RouteLocationRaw | undefined;
  /** The link being removed now, by its key. */
  removing?: string;
  empty?: string;
}>(), { removing: '', empty: 'No links.' });
const emit = defineEmits<{ remove: [link: ContextLink] }>();

/** The far end of a link: its target going out, the item it starts at coming in. */
const endOf = (link: ContextLink): LinkTarget => (props.direction === 'out' ? link.to : { kind: 'context', name: link.from });
const groups = computed(() => groupLinks(props.links).map((group) => ({
  relation: group.relation,
  rows: group.links.map((link) => {
    const end = endOf(link);
    return { link, key: linkKey(link), end, route: props.routeOf(end), canRemove: props.direction === 'out' && removable(link) };
  }),
})));
</script>

<template>
  <div class="groups" :data-direction="direction">
    <p v-if="groups.length === 0" class="none">{{ empty }}</p>
    <section v-for="group in groups" :key="group.relation" class="group" :data-relation="group.relation">
      <h3 class="relation" :title="RELATION_WORDS[group.relation].about">
        {{ direction === 'out' ? RELATION_WORDS[group.relation].label : RELATION_WORDS[group.relation].back }}
        <span class="count">{{ group.rows.length }}</span>
      </h3>
      <ul class="links">
        <li v-for="{ link, key, end, route, canRemove } in group.rows" :key="key" class="link" :class="{ leaving: removing === key }" data-testid="context-link" :data-source="link.source">
          <span class="kind" :title="TARGET_WORDS[end.kind].label"><UiIcon :name="TARGET_WORDS[end.kind].icon" :size="14" /></span>
          <span class="end">
            <RouterLink v-if="route !== undefined" class="target" :to="route">{{ targetText(end) }}</RouterLink>
            <code v-else class="target plain">{{ targetText(end) }}</code>
            <span class="source">{{ SOURCE_WORDS[link.source] }}<template v-if="link.uses !== undefined"> · used together {{ Math.round(link.uses) }}×</template></span>
          </span>
          <span class="weight" :title="`Weight ${link.weight.toFixed(2)}`">
            <span class="bar" aria-hidden="true"><span class="fill" :style="{ width: `${weightPercent(link.weight)}%` }" /></span>
            <span class="number">{{ link.weight.toFixed(2) }}</span>
          </span>
          <UiIconButton
            v-if="canRemove" icon="trash" size="sm" :label="`Remove the link to ${targetText(link.to)}`"
            :disabled="removing !== ''" data-testid="remove-link" @click="emit('remove', link)"
          />
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.groups { display: grid; gap: var(--space-4); }
.none { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.group { display: grid; gap: var(--space-2); }
.relation { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: 0.04em; text-transform: uppercase; }
.count { padding: 0 6px; border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-faint); font-variant-numeric: tabular-nums; letter-spacing: 0; }
.links { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); list-style: none; overflow: hidden; }
.link { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); min-height: 48px; padding: var(--space-2) var(--space-3); transition: opacity var(--fast) var(--ease); }
.link + .link { border-top: 1px solid var(--border); }
.leaving { opacity: 0.5; }
.kind { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-dim); }
.end { display: grid; gap: 1px; min-width: 0; }
.target { font-family: var(--mono); font-size: var(--text-sm); overflow-wrap: anywhere; }
.plain { color: var(--text); }
.source { color: var(--text-faint); font-size: var(--text-xs); }
.weight { display: flex; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.bar { width: 56px; height: 6px; border-radius: var(--radius-full); background: var(--surface-3); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width var(--medium) var(--ease); }
@media (max-width: 559.98px) {
  .link { grid-template-columns: auto minmax(0, 1fr) auto; }
  .weight { grid-column: 2; grid-row: 2; }
  .bar { width: 72px; }
}
</style>
