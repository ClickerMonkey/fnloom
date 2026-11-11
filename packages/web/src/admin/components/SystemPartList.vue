<script setup lang="ts">
/**
 * What a system added beyond its fns, context and types, under one heading each: its resource roots (live, each
 * opening in Files), then its kinds, `/commands`, mentions, hooks, actions, settings, attachments, embedders,
 * sectioners, model providers, registries, the registry components it contributes and its fns' examples. Every part
 * says where it came from (its contract or added while running), its version and, where it has one, who sees it;
 * opening one shows its declaration, and a part that belongs to a fn or context item links to that item's page.
 */
import type { QualifiedName, ResourceRoot, SystemPart, SystemPartSection } from '@harness/core';
import { ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { AUDIENCE_WORDS, DECLARED_WORDS } from '../../context/logic/context.ts';
import { UiBadge, UiCodeBlock, UiIcon } from '../../ui/index.ts';
import { PART_SECTION_WORDS, shortVersion, type PartGroup } from '../logic/systems.ts';

defineProps<{
  groups: readonly PartGroup[];
  roots: readonly ResourceRoot[];
  /** A root's folder in Files. */
  rootPage: (root: ResourceRoot) => RouteLocationRaw;
  /** The page of the fn (an example's) or context item (a `/command`'s) a part belongs to. */
  ownerPage: (section: SystemPartSection, owner: QualifiedName) => RouteLocationRaw;
}>();

/** How a root is indexed, in words. */
const INDEX_WORDS = { all: 'Indexed', 'on-read': 'Indexed when read', none: 'Not indexed' } as const satisfies Record<ResourceRoot['index'], string>;

const open = ref('');
const keyOf = (part: SystemPart): string => `${part.section}:${part.name}`;
const toggle = (part: SystemPart): void => { open.value = open.value === keyOf(part) ? '' : keyOf(part); };
</script>

<template>
  <div class="groups" data-testid="system-parts">
    <section v-if="roots.length > 0" class="group" data-section="roots">
      <h3 class="heading">Resource roots <span class="count">{{ roots.length }}</span></h3>
      <ul class="list">
        <li v-for="root in roots" :key="root.uri">
          <RouterLink class="row link" :to="rootPage(root)" data-testid="system-root">
            <UiIcon name="folder" :size="14" class="lead" />
            <span class="main">
              <span class="name">{{ root.name }}</span>
              <span v-if="root.description !== ''" class="about">{{ root.description }}</span>
            </span>
            <span class="side"><code class="uri">{{ root.uri }}</code><span>{{ INDEX_WORDS[root.index] }}{{ root.watch ? ' · watched' : '' }}</span></span>
          </RouterLink>
        </li>
      </ul>
    </section>
    <section v-for="group in groups" :key="group.section" class="group" :data-section="group.section">
      <h3 class="heading">
        {{ PART_SECTION_WORDS[group.section] }} <span class="count">{{ group.total }}</span>
        <span v-if="group.total > group.parts.length" class="cut">showing the first {{ group.parts.length }}</span>
      </h3>
      <ul class="list">
        <li v-for="part in group.parts" :key="keyOf(part)" :data-part="part.name">
          <button type="button" class="row" :aria-expanded="open === keyOf(part)" data-testid="system-part" @click="toggle(part)">
            <UiIcon :name="open === keyOf(part) ? 'chevron-down' : 'chevron-right'" :size="14" class="lead" />
            <span class="main">
              <code class="name">{{ part.name }}</code>
              <span v-if="part.about !== ''" class="about">{{ part.about }}</span>
            </span>
            <span class="side">
              <span>{{ DECLARED_WORDS[part.origin] }}<code class="version" :title="`Version ${part.version}`">{{ shortVersion(part.version) }}</code></span>
              <UiBadge v-if="part.visibility !== undefined">Seen by {{ AUDIENCE_WORDS[part.visibility].toLowerCase() }}</UiBadge>
            </span>
          </button>
          <div v-if="open === keyOf(part)" class="body">
            <RouterLink v-if="part.owner !== undefined" :to="ownerPage(part.section, part.owner)" class="owner" data-testid="system-part-owner">
              Open {{ part.owner }}
            </RouterLink>
            <UiCodeBlock :code="JSON.stringify(part.decl, null, 2)" language="json" :max-height="320" wrap />
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.groups { display: grid; gap: var(--space-4); }
.group { display: grid; gap: var(--space-2); min-width: 0; }
.heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.count { color: var(--text-faint); font-weight: var(--weight-medium); }
.cut { color: var(--text-faint); font-size: var(--text-xs); font-weight: normal; }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); width: 100%;
  padding: var(--space-2) var(--space-4); border: 0; background: none; color: var(--text); font: inherit; text-align: left; text-decoration: none; cursor: pointer;
}
.row:hover { background: var(--surface-2); text-decoration: none; }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.lead { color: var(--text-faint); }
.main { display: grid; gap: 2px; min-width: 0; }
.name { font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.about { color: var(--text-dim); font-size: var(--text-sm); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-1) var(--space-2); color: var(--text-dim); font-size: var(--text-xs); white-space: nowrap; }
.uri { color: var(--text-faint); overflow-wrap: anywhere; white-space: normal; }
.version { margin-left: var(--space-2); color: var(--text-faint); }
.body { display: grid; gap: var(--space-2); padding: 0 var(--space-4) var(--space-3); min-width: 0; }
.owner { justify-self: start; font-size: var(--text-sm); }
@media (max-width: 559.98px) {
  .row { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .side { grid-column: 2; justify-content: flex-start; }
}
</style>
