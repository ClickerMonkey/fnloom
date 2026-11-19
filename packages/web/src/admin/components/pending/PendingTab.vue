<script setup lang="ts">
/**
 * A system's Pending tab: what waits since it went live, read in order of risk. The hub's summary strip first (counts,
 * how the grants and config moved, the risk flags), then the changes grouped by section, each drawn with its tab's
 * view and decided one by one (approve, or decline to keep it off), with Approve all and Decline all for the rest.
 * Below, what was declined before. The live version keeps working throughout.
 */
import type { ContractChange, SystemReview } from '@harness/core';
import { computed } from 'vue';
import ReviewSummaryStrip from '../../../components/approvals/ReviewSummaryStrip.vue';
import FnPill from '../../../fns/components/FnPill.vue';
import { fullTime, relativeTime, UiButton, UiEmpty } from '../../../ui/index.ts';
import { CHANGE_LOOK, CHANGE_SECTION_WORDS } from '../../logic/review.ts';
import ChangeList from '../ChangeList.vue';

const props = withDefaults(defineProps<{
  review: SystemReview;
  now: number;
  /** The key of the change being decided now. */
  deciding?: string | undefined;
  busy?: boolean;
}>(), { deciding: undefined, busy: false });
const emit = defineEmits<{ approve: [change: ContractChange]; decline: [change: ContractChange]; approveAll: []; declineAll: [] }>();

const pending = computed(() => props.review.pending);
/** The most declined changes listed. */
const DECLINED_SHOWN = 10;
const declined = computed(() => props.review.declined.slice(0, DECLINED_SHOWN));
</script>

<template>
  <div class="pending" data-testid="pending-tab">
    <template v-if="pending">
      <ReviewSummaryStrip :summary="pending.summary" />
      <div class="bar">
        <p class="since">
          {{ pending.by === 'contract' ? `Version ${pending.version}` : 'Added while running' }}, waiting since
          <time :datetime="new Date(pending.since).toISOString()" :title="fullTime(pending.since)">{{ relativeTime(pending.since, now) }}</time>.
        </p>
        <div class="all">
          <UiButton variant="ghost" size="sm" :disabled="busy" data-testid="decline-all" @click="emit('declineAll')">Decline all</UiButton>
          <UiButton variant="primary" size="sm" icon="check" :disabled="busy" data-testid="approve-all" @click="emit('approveAll')">Approve all {{ pending.changes.length }}</UiButton>
        </div>
      </div>
      <ChangeList :changes="pending.changes" :facts="pending.fns" :deciding="deciding" :busy="busy" @approve="(change) => emit('approve', change)" @decline="(change) => emit('decline', change)" />
    </template>
    <UiEmpty v-else icon="check" title="Nothing waits" :body="review.stage === 'installed' ? 'It isn’t live yet: everything is under review.' : 'What is live is what was reviewed.'" />
    <section v-if="declined.length > 0" class="declined" data-testid="review-declined">
      <h3 class="heading">Declined</h3>
      <ul>
        <li v-for="item in declined" :key="`${item.section}:${item.name}:${item.at}`">
          <FnPill v-if="item.section === 'fns'" :name="item.name" off />
          <code v-else>{{ item.name }}</code>
          <span class="dim">{{ CHANGE_LOOK[item.change].word.toLowerCase() }} {{ CHANGE_SECTION_WORDS[item.section].toLowerCase() }} in {{ item.version }}</span>
          <time class="at" :datetime="new Date(item.at).toISOString()" :title="fullTime(item.at)">{{ relativeTime(item.at, now) }}</time>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.pending { display: grid; gap: var(--space-3); min-width: 0; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.since { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.all { display: flex; gap: var(--space-1); margin-left: auto; }
.declined { display: grid; gap: var(--space-2); padding-top: var(--space-2); border-top: 1px dashed var(--border); }
.heading { margin: 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.05em; }
.declined ul { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.declined li { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); font-size: var(--text-sm); }
.declined code { overflow-wrap: anywhere; text-decoration: line-through; text-decoration-color: var(--danger); }
.dim, .at { color: var(--text-faint); font-size: var(--text-xs); }
.at { margin-left: auto; white-space: nowrap; }
</style>
