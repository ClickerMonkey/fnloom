<script setup lang="ts">
/** Facts as label and value pairs (a service's URL, sign-in, limits); a value that is code is drawn as code. */
import type { Fact } from '../logic/service-views.ts';

defineProps<{ facts: readonly Fact[]; testid: string }>();
</script>

<template>
  <dl class="facts" :data-testid="testid">
    <template v-for="fact in facts" :key="fact.label">
      <dt>{{ fact.label }}</dt>
      <dd :title="fact.title"><code v-if="fact.code">{{ fact.value }}</code><template v-else>{{ fact.value }}</template></dd>
    </template>
  </dl>
</template>

<style scoped>
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
.facts dt { color: var(--text-dim); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
/* phones keep the two columns, closer together */
@media (max-width: 479.98px) { .facts { gap: var(--space-1) var(--space-3); } }
</style>
