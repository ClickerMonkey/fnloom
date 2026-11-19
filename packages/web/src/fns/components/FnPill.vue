<script setup lang="ts">
/**
 * A fn wherever one is named: its friendly label ("Read file") tinted by its system, with the qualified name (and what
 * blocks it) on hover. A click opens the app's fn modal (`?fn=`) over whatever is open. A glob (`hub/*`) or a whole
 * system (`database`) can't open as one fn, so it links admins to the fns list filtered to what it matches. With `blocked` (the hub's structured block) or
 * an `available` that says no, it looks off and says why. Outside the app (no modal) it is a plain label.
 */
import type { Availability } from '@harness/core';
import { computed } from 'vue';
import { useStoresIfAny } from '../../state/stores.ts';
import { UiIcon, hueOf } from '../../ui/index.ts';
import { blockOfAvailability, blockWord, matchLink, pillTarget, pillTitle, type PillBlock } from '../logic/pill.ts';
import { useFnModal } from '../state/fn-modal.ts';

const props = withDefaults(defineProps<{
  /** A qualified name, a glob or a system's name. */
  name: string;
  /** What blocks it, as the hub said. */
  blocked?: PillBlock | undefined;
  /** Its availability, where the caller has that instead of a block. */
  available?: Availability | undefined;
  /** Switched off (by an admin, or in what is being shown) without a reason to give. */
  off?: boolean;
  /** Words in place of the friendly label (an approval's own title). */
  label?: string | undefined;
}>(), { blocked: undefined, available: undefined, off: false, label: undefined });

const modal = useFnModal();
const stores = useStoresIfAny();
const target = computed(() => pillTarget(props.name));
const block = computed(() => props.blocked ?? blockOfAvailability(props.available));
const qualified = computed(() => (target.value.kind === 'fn' ? target.value.fn : props.name));
const title = computed(() => pillTitle(qualified.value, block.value));
const system = computed(() => qualified.value.split('/')[0] ?? qualified.value);
const tint = computed(() => `oklch(0.62 0.13 ${hueOf(system.value)})`);
const muted = computed(() => props.off || block.value !== undefined);
const canMatch = computed(() => stores?.session.user.value?.role === 'admin');
const text = computed(() => props.label ?? target.value.label);
</script>

<template>
  <button
    v-if="target.kind === 'fn' && modal" type="button" class="fn-pill live" :class="{ muted }" :style="{ '--pill': tint }" :title="title"
    :data-fn="target.fn" data-testid="fn-pill" @click.stop="modal.open(target.fn)"
  >
    <UiIcon name="fn" :size="12" /><span class="label">{{ text }}</span><span v-if="block" class="state">{{ blockWord(block) }}</span>
  </button>
  <RouterLink
    v-else-if="target.kind === 'match' && canMatch" class="fn-pill live match" :style="{ '--pill': tint }" :title="`${name}: the fns it matches`"
    :to="matchLink(target.query)" :data-fn="name" data-testid="fn-pill"
  >
    <UiIcon name="filter" :size="12" /><span class="label">{{ text }}</span>
  </RouterLink>
  <span v-else class="fn-pill" :class="{ muted, match: target.kind === 'match' }" :style="{ '--pill': tint }" :title="title" :data-fn="name" data-testid="fn-pill">
    <UiIcon :name="target.kind === 'match' ? 'filter' : 'fn'" :size="12" /><span class="label">{{ text }}</span><span v-if="block" class="state">{{ blockWord(block) }}</span>
  </span>
</template>

<style scoped>
.fn-pill {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-height: 22px; padding: 1px 8px; vertical-align: baseline;
  border: 1px solid color-mix(in oklch, var(--pill) 32%, transparent); border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--pill) 12%, transparent); color: var(--text); font: inherit; font-size: var(--text-sm); line-height: 1.2;
  text-decoration: none; transition: background-color var(--fast) var(--ease), border-color var(--fast) var(--ease), transform var(--fast) var(--ease);
}
.fn-pill :deep(svg) { flex: none; color: var(--pill); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live { cursor: pointer; }
.live:hover { background: color-mix(in oklch, var(--pill) 22%, transparent); border-color: color-mix(in oklch, var(--pill) 55%, transparent); text-decoration: none; }
.live:active { transform: scale(0.97); }
.live:focus-visible { outline: none; box-shadow: var(--ring); }
.match { border-style: dashed; }
.muted { border-style: dashed; background: var(--surface-2); color: var(--text-dim); }
.muted :deep(svg) { color: var(--text-faint); }
.muted .label { text-decoration: line-through; text-decoration-color: color-mix(in oklch, currentColor 45%, transparent); }
.state {
  padding: 0 5px; border-radius: var(--radius-full); background: var(--warn-soft); color: var(--warn); font-size: var(--text-xs);
  font-weight: var(--weight-medium); text-transform: lowercase;
}
@media (prefers-reduced-motion: reduce) { .fn-pill { transition: none; } .live:active { transform: none; } }
</style>
