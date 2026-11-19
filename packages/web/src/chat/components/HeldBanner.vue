<script setup lang="ts">
/**
 * On a turn that hit a system held for review (`heldSystems`): a warning banner, "database has changes waiting for
 * review", with the fns the turn was refused because of it. Someone who can review (an admin) gets a link to that
 * system's pending review; anyone else sees the words alone.
 */
import { RouterLink } from 'vue-router';
import { links } from '../../app/routes.ts';
import { UiBanner, UiIcon } from '../../ui/index.ts';
import { heldDetail, heldLine, type HeldSystem } from '../logic/held.ts';

defineProps<{ held: HeldSystem; canReview: boolean }>();
</script>

<template>
  <UiBanner tone="warn" icon="shield" class="held" data-testid="held-banner" :data-system="held.system">
    <span class="line">{{ heldLine(held) }}</span>
    <span v-if="held.fns.length > 0" class="detail"> · {{ heldDetail(held) }}</span>
    <template v-if="canReview" #actions>
      <RouterLink class="review" :to="links.review(held.system, 'pending')" data-testid="held-review">
        Review changes<UiIcon name="chevron-right" :size="14" />
      </RouterLink>
    </template>
  </UiBanner>
</template>

<style scoped>
.held { flex-wrap: wrap; }
.line { font-weight: var(--weight-medium); }
.detail { color: var(--text-dim); overflow-wrap: anywhere; }
.review {
  display: inline-flex; align-items: center; gap: 2px; min-height: 28px; padding: 0 var(--space-2); border-radius: var(--radius-sm);
  color: var(--text); font-weight: var(--weight-medium); text-decoration: none; transition: background var(--fast) var(--ease);
}
.review:hover, .review:focus-visible { background: color-mix(in oklch, var(--warn) 16%, transparent); }
</style>
