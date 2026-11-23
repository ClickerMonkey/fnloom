<script setup lang="ts">
/**
 * What a change does to what agents are told, on its review card: each target of the injection (`hub/chat*`,
 * `crm/reviewer`) with the agents it hits now as pills, "hits no agent yet" for a pattern that hits none, and its
 * rough size, and the items it takes out of those agents' sections (`replaces`). A hook's `explains` names no targets:
 * it goes into the agents that get the hook's blocks.
 */
import type { InjectionChangeView } from '@harness/core';
import { computed } from 'vue';
import FnPill from '../../../fns/components/FnPill.vue';

const props = defineProps<{ injection: InjectionChangeView }>();

/** The words before the targets, by what happened to the injection. */
const LEAD = { added: 'Will be told to', changed: 'Changes what is told to', removed: 'No longer told to' } as const;
const lead = computed(() => LEAD[props.injection.change]);
</script>

<template>
  <section class="inject" data-testid="inject-targets" :data-change="injection.change">
    <p class="lead">
      <strong>{{ lead }}</strong>
      <span v-if="injection.tokens !== undefined" class="dim">· about {{ injection.tokens.toLocaleString('en-US') }} tokens</span>
    </p>
    <ul v-if="injection.section === 'context'" class="targets">
      <li v-for="target in injection.targets" :key="target.target" class="target" data-testid="inject-target">
        <code class="pattern">{{ target.target }}</code>
        <span class="arrow" aria-hidden="true">→</span>
        <span v-if="target.agents.length > 0" class="agents"><FnPill v-for="agent in target.agents" :key="agent" :name="agent" /></span>
        <span v-else class="none" data-testid="inject-no-agent">hits no agent yet</span>
      </li>
    </ul>
    <p v-else class="dim">The agents that get {{ injection.name }}'s blocks.</p>
    <p v-if="injection.replaces !== undefined && injection.change !== 'removed'" class="replaces" data-testid="inject-replaces">
      Takes <template v-for="(name, i) in injection.replaces" :key="name"><code>{{ name }}</code><template v-if="i < injection.replaces.length - 1">, </template></template>
      out of their sections while it is in.
    </p>
  </section>
</template>

<style scoped>
.inject { display: grid; gap: var(--space-1); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--warn-soft); font-size: var(--text-sm); }
.lead { margin: 0; }
.dim { color: var(--text-faint); font-size: var(--text-xs); }
p.dim { margin: 0; }
.targets { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.target { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
.pattern { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.arrow { color: var(--text-faint); }
.agents { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.none { color: var(--text-dim); font-style: italic; }
.replaces { margin: 0; color: var(--text-dim); }
</style>
