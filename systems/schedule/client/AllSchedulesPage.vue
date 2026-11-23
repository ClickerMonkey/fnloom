<script setup lang="ts">
/**
 * Every schedule on the hub (`/s/schedule/all`, admins): each schedule fn with its owner, the fn it runs, what it says,
 * its next run and whether it is paused, searched (`?q=`) and paged by the hub's fns list, so an admin can see and
 * stop anything that runs by itself. Pause and Resume run the schedule fns as the admin, in a chat made for the page.
 */
import type { Json, QualifiedName } from '@harness/core';
import type { PageViewOf } from '@harness/sdk';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ScheduleContract } from '../shared/index.ts';
import { nextFirings } from '../shared/when.ts';
import { plainClick } from './host.ts';
import { instantWords, localOf, pausedOn, saysOf, SCHEDULE_FNS, SCHEDULE_PAGES, todayIn, viewerZone } from './logic.ts';
import { AllSchedules, type AdminSchedule } from './state.ts';

/** How long typing rests before the words go to the URL and the hub (ms). */
const SETTLE = 250;

const props = defineProps<PageViewOf<ScheduleContract>>();
const host = props.host;
const { Frame, Input, Button, Badge, FnPill, LoadState, Empty, Approval } = host.components;

const zone = computed(() => viewerZone(host.user.timeZone));
const now = ref(Date.now());
const today = computed(() => todayIn(zone.value, now.value));

const words = ref(host.query.get('q') ?? '');
let settle: ReturnType<typeof setTimeout> | undefined;
watch(words, (next) => { clearTimeout(settle); settle = setTimeout(() => { host.query.set({ q: next.trim() }); }, SETTLE); });

const list = new AllSchedules(host.hub);
watch(() => host.query.values['q'] ?? '', (q) => { if (q !== words.value.trim()) { words.value = q; } void list.show(q); }, { immediate: true });

const says = (row: AdminSchedule): string => (row.payload === undefined ? 'Its payload doesn’t read.' : saysOf(row.payload, zone.value, today.value));
const paused = (row: AdminSchedule): boolean => row.payload !== undefined && pausedOn(row.payload, today.value);
const next = (row: AdminSchedule): string => {
  if (row.payload === undefined || paused(row)) { return '—'; }
  const first = nextFirings(row.payload.when, row.payload.zone, now.value, 1)[0];
  return first === undefined ? 'No runs left' : instantWords(first.at, zone.value, today.value);
};
const itemTo = (fn: QualifiedName) => ({ page: SCHEDULE_PAGES.item, path: [localOf(fn)], query: {} });
function open(event: MouseEvent, fn: QualifiedName): void { if (plainClick(event)) { host.go(itemTo(fn)); } }

// pause and resume, as the admin's own runs
const runs = host.runs({ title: () => 'All schedules' });
onBeforeUnmount(() => { runs.close(); clearTimeout(settle); });
const acting = ref('');
async function toggle(row: AdminSchedule): Promise<void> {
  const fn = paused(row) ? SCHEDULE_FNS.resume : SCHEDULE_FNS.pause;
  acting.value = row.fn;
  const outcome = await runs.run(fn, { schedule: row.fn } satisfies Record<string, Json>);
  acting.value = '';
  if (outcome.ok) { host.notify.ok(paused(row) ? 'Resumed' : 'Paused'); void list.show(words.value); } else { host.notify.error("Couldn't change it", outcome.problem); }
}
async function decide(approve: boolean, remember: Parameters<typeof runs.approve>[2], reason: string, answer: Json | undefined): Promise<void> {
  const approval = runs.approvals[0];
  if (approval !== undefined && !(await runs.approve(approval, approve, remember, reason, answer))) { host.notify.error("Couldn't send your answer", runs.problem); }
}
</script>

<template>
  <Frame title="All schedules" description="Every schedule on the hub, by owner: what runs by itself, and when." width="wide" keep-title>
    <template #crumb><a :href="host.href({ page: SCHEDULE_PAGES.calendar })" @click="plainClick($event) && host.go({ page: SCHEDULE_PAGES.calendar })">Schedule</a></template>
    <div class="bar">
      <Input v-model="words" type="search" icon="search" label="Search schedules" placeholder="Search schedules by name" hide-label clearable data-testid="all-search" />
    </div>
    <section v-if="runs.approvals.length > 0" class="waiting"><Approval :approval="runs.approvals[0]!" in-chat @decide="decide" /></section>
    <LoadState
      :loading="list.loading.value && !list.loaded.value" :problem="list.problem.value" :ready="list.loaded.value" :empty="list.items.value.length === 0" empty-icon="calendar"
      :empty-title="words ? 'No schedules match' : 'No schedules on this hub'" :empty-body="words ? 'Try other words.' : 'When someone schedules a fn to run later, it shows here.'" @retry="list.show(words)"
    >
      <div class="table" role="table" aria-label="Schedules" data-testid="all-schedules">
        <div class="row head" role="row">
          <span role="columnheader">Schedule</span><span role="columnheader">Owner</span><span role="columnheader">When</span><span role="columnheader">Next run</span><span role="columnheader" class="end">Status</span>
        </div>
        <div v-for="row in list.items.value" :key="row.fn" class="row" role="row" data-testid="all-row" :data-schedule="row.fn">
          <span class="cell name" role="cell">
            <a :href="host.href(itemTo(row.fn))" @click="open($event, row.fn)">{{ localOf(row.fn).replace(/_/g, ' ') }}</a>
            <FnPill v-if="row.payload" :name="row.payload.fn" />
          </span>
          <span class="cell owner" role="cell"><span class="k">Owner</span>{{ row.ownerName }}</span>
          <span class="cell says" role="cell"><span class="k">When</span>{{ says(row) }}</span>
          <span class="cell next" role="cell"><span class="k">Next</span>{{ next(row) }}</span>
          <span class="cell end" role="cell">
            <Badge v-if="row.disabled" tone="danger" dot>Off</Badge>
            <Badge v-else-if="paused(row)" tone="neutral" dot>Paused</Badge>
            <Badge v-else tone="ok" dot>Running</Badge>
            <Button size="sm" variant="ghost" :icon="paused(row) ? 'play' : 'pause'" :loading="acting === row.fn" :disabled="acting !== '' || row.payload === undefined" data-testid="all-toggle" @click="toggle(row)">
              {{ paused(row) ? 'Resume' : 'Pause' }}
            </Button>
          </span>
        </div>
      </div>
      <div v-if="list.hasMore.value" class="more">
        <Button variant="ghost" size="sm" :loading="list.loadingMore.value" data-testid="all-more" @click="list.more()">Show more</Button>
      </div>
      <template #empty><Empty icon="calendar" :title="words ? 'No schedules match' : 'No schedules on this hub'" /></template>
    </LoadState>
  </Frame>
</template>

<style scoped>
.bar { display: flex; margin-bottom: var(--space-4); max-width: 520px; }
.bar > * { flex: 1; }
.waiting { margin-bottom: var(--space-4); }
.table { display: grid; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(180px, 1.2fr) minmax(100px, 0.7fr) minmax(200px, 1.6fr) minmax(140px, 0.9fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); }
.row + .row { border-top: 1px solid var(--border); }
.row:not(.head):hover { background: var(--surface-2); }
.head { background: var(--surface-2); color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.04em; }
.cell { min-width: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.name { display: grid; gap: var(--space-1); justify-items: start; }
.name a { color: var(--text); font-weight: var(--weight-medium); text-decoration: none; text-transform: capitalize; }
.name a:hover { color: var(--accent); }
.owner, .next { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.end { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); }
.k { display: none; }
.more { display: flex; justify-content: center; padding-top: var(--space-3); }
@media (max-width: 899.98px) {
  .head { display: none; }
  .row { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  .k { display: inline; margin-right: var(--space-2); color: var(--text-faint); font-size: var(--text-xs); text-transform: uppercase; }
  .end { justify-content: flex-start; padding-top: var(--space-1); }
}
</style>
