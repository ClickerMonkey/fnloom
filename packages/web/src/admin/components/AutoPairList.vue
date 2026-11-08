<script setup lang="ts">
/**
 * A system's auto pair secrets (never the secrets themselves): for each, its instance, whether it is active, expired
 * or revoked, when it was made and ends, and how often it was used. An active one can be revoked.
 */
import type { AutoPairId, AutoPairView } from '@harness/core';
import { UiButton, fullTime, relativeTime } from '../../ui/index.ts';
import { AUTO_PAIR_STATE_LOOK, autoPairState, endsText } from '../logic/systems.ts';
import StatusBadge from './StatusBadge.vue';

defineProps<{ secrets: readonly AutoPairView[]; now: number; busy?: boolean }>();
const emit = defineEmits<{ revoke: [id: AutoPairId] }>();
</script>

<template>
  <ul class="secrets" data-testid="auto-pairs">
    <li v-for="secret in secrets" :key="secret.id" class="secret" :data-auto-pair="secret.id">
      <span class="main">
        <span class="top">
          <code class="name">{{ secret.system }}@{{ secret.instance }}</code>
          <StatusBadge :look="AUTO_PAIR_STATE_LOOK[autoPairState(secret, now)]" />
        </span>
        <span class="facts">
          made <time :title="fullTime(secret.createdAt)">{{ relativeTime(secret.createdAt, now) }}</time>
          · <time :title="secret.expiresAt === undefined ? undefined : fullTime(secret.expiresAt)">{{ endsText(secret.expiresAt, now) }}</time>
          · used {{ secret.uses === 1 ? 'once' : `${secret.uses} times` }}<template v-if="secret.lastUsedAt !== undefined">, last <time :title="fullTime(secret.lastUsedAt)">{{ relativeTime(secret.lastUsedAt, now) }}</time></template>
        </span>
      </span>
      <UiButton
        v-if="autoPairState(secret, now) === 'active'" size="sm" variant="ghost" icon="x" :disabled="busy" :data-testid="`revoke-${secret.id}`"
        @click="emit('revoke', secret.id)"
      >
        Revoke
      </UiButton>
    </li>
  </ul>
</template>

<style scoped>
.secrets { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.secret { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); }
.secret + .secret { border-top: 1px solid var(--border); }
.main { display: grid; flex: 1; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.name { font-size: var(--text-sm); overflow-wrap: anywhere; }
.facts { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
</style>
