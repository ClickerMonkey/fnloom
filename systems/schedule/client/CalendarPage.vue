<script setup lang="ts">
/**
 * The Schedule page (`/s/schedule/calendar`): the person's schedules on a month, week or agenda calendar (agenda the
 * default on a phone). Coming firings are worked out in the browser from each schedule's payload by the same dayspan
 * code the server plans with (`shared/when.ts`), so paging on needs no server round trip; past ones are the person's
 * `schedule/Firing` records in their status colours. The view, day, filters and the open entry are in the URL. An
 * entry opens a panel with its status, summary and args, and links to its run's page (or, before it ran, to the
 * schedule's page at that firing) and to the schedule.
 */
import type { PageViewOf } from '@harness/sdk';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ScheduleContract } from '../shared/index.ts';
import AgendaList from './AgendaList.vue';
import CalendarGrid from './CalendarGrid.vue';
import { goTarget, plainClick, targetHref } from './host.ts';
import {
  calendarUrl, CALENDAR_VIEWS, entriesByDay, entriesFor, entryLook, entryTarget, filterEntries, instantWords, localOf, rangeDays, rangeInstants, rangeTitle,
  SCHEDULE_PAGES, STATUS_CHOICES, stepDay, todayIn, viewerZone, viewOf, type CalendarEntry, type CalendarView,
} from './logic.ts';
import { MySchedules, RangeFirings } from './state.ts';

/** How often the page reads its schedules and firings again while open (ms). */
const REFRESH = 30_000;
const VIEW_WORDS: Record<CalendarView, string> = { month: 'Month', week: 'Week', agenda: 'Agenda' };

const props = defineProps<PageViewOf<ScheduleContract>>();
const host = props.host;
const { Frame, Button, Select, LoadState, Empty, Dialog, Badge, FnPill, Banner } = host.components;

const width = ref(typeof window === 'undefined' ? 1024 : window.innerWidth);
const onResize = (): void => { width.value = window.innerWidth; };
onMounted(() => { window.addEventListener('resize', onResize); });
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); });

const zone = computed(() => viewerZone(host.user.timeZone));
const now = ref(Date.now());
const today = computed(() => todayIn(zone.value, now.value));
const url = computed(() => calendarUrl(host.query.values));
const view = computed(() => viewOf(url.value, width.value));
const day = computed(() => url.value.day ?? today.value);
const days = computed(() => rangeDays(view.value, day.value));
const range = computed(() => rangeInstants(days.value, zone.value));
const title = computed(() => rangeTitle(view.value, day.value));

const schedules = new MySchedules(host.hub);
const firings = new RangeFirings(host.hub);
void schedules.load();
watch(() => JSON.stringify({ ...range.value, schedule: url.value.schedule, status: url.value.status }), () => {
  void firings.show(range.value.from, range.value.to, { schedule: url.value.schedule, status: url.value.status });
}, { immediate: true });
host.live(() => { now.value = Date.now(); void schedules.load(); void firings.refresh(); }, REFRESH);

const entries = computed(() => filterEntries(entriesFor({
  schedules: schedules.items.value, firings: firings.items.value, from: range.value.from, to: range.value.to, now: now.value, zone: zone.value,
}), url.value));
const byDay = computed(() => entriesByDay(entries.value));
const ready = computed(() => schedules.loaded.value && firings.loaded.value);
const problem = computed(() => schedules.problem.value || firings.problem.value);
const none = computed(() => ready.value && schedules.items.value.length === 0 && firings.items.value.length === 0 && url.value.schedule === undefined && url.value.status === undefined);
const filtered = computed(() => url.value.schedule !== undefined || url.value.status !== undefined);

const scheduleChoices = computed(() => [
  { value: '', label: 'All schedules' },
  ...schedules.items.value.map((item) => ({ value: item.fn, label: item.payload.paused === undefined ? item.title : `${item.title} (paused)` })),
]);
const scheduleFilter = host.query.bind('schedule');
const statusFilter = host.query.bind('status');

function setView(next: CalendarView): void { host.query.set({ view: next, entry: undefined }); }
function step(by: -1 | 1): void { host.query.set({ day: stepDay(view.value, day.value, by) }); }
function toToday(): void { host.query.set({ day: undefined }); }
/** A day picked in the grid: its agenda, from that day. */
function openDay(picked: string): void { host.query.set({ view: 'agenda', day: picked }, { push: true }); }
function toAll(event: MouseEvent): void { if (plainClick(event)) { host.go({ page: SCHEDULE_PAGES.all }); } }
function clear(): void { host.query.set({ schedule: undefined, status: undefined }); }

// ── the open entry ────────────────────────────────────────────────────────────

const open = computed((): CalendarEntry | undefined => (url.value.entry === undefined ? undefined : entries.value.find((entry) => entry.id === url.value.entry)));
const panelOpen = computed({
  get: () => open.value !== undefined,
  set: (value: boolean) => { if (!value) { host.query.set({ entry: undefined }); } },
});
function show(entry: CalendarEntry): void { host.query.set({ entry: entry.id }, { push: true }); }
const scheduleTo = (entry: CalendarEntry) => ({ page: SCHEDULE_PAGES.item, path: [localOf(entry.schedule)], query: {} });
function follow(event: MouseEvent, entry: CalendarEntry): void {
  if (plainClick(event)) { goTarget(host, entryTarget(entry)); }
}
function toSchedule(event: MouseEvent, entry: CalendarEntry): void {
  if (plainClick(event)) { host.go(scheduleTo(entry)); }
}
const argsText = (entry: CalendarEntry): string => JSON.stringify(entry.args, null, 2);
</script>

<template>
  <Frame title="Schedule" description="Your scheduled runs: what ran, how it went, and what runs next." width="wide" keep-title>
    <template #actions>
      <a v-if="host.user.role === 'admin'" class="admin-link" :href="host.href({ page: SCHEDULE_PAGES.all })" @click="toAll">All schedules</a>
    </template>

    <div class="toolbar" data-testid="schedule-toolbar">
      <div class="nav">
        <Button variant="secondary" size="sm" data-testid="schedule-today" @click="toToday">Today</Button>
        <Button variant="ghost" size="sm" icon="chevron-left" aria-label="Earlier" data-testid="schedule-prev" @click="step(-1)" />
        <Button variant="ghost" size="sm" icon="chevron-right" aria-label="Later" data-testid="schedule-next" @click="step(1)" />
        <h2 class="range" aria-live="polite" data-testid="schedule-range">{{ title }}</h2>
      </div>
      <div class="views" role="radiogroup" aria-label="View">
        <button
          v-for="option in CALENDAR_VIEWS" :key="option" type="button" role="radio" class="view" :aria-checked="view === option ? 'true' : 'false'"
          :data-testid="`schedule-view-${option}`" @click="setView(option)"
        >
          {{ VIEW_WORDS[option] }}
        </button>
      </div>
      <div class="filters">
        <Select v-model="scheduleFilter.value" :options="scheduleChoices" label="Schedule" hide-label size="sm" data-testid="schedule-filter" />
        <Select v-model="statusFilter.value" :options="STATUS_CHOICES" label="Status" hide-label size="sm" data-testid="status-filter" />
      </div>
    </div>

    <Banner v-if="problem && ready" tone="danger">{{ problem }}</Banner>
    <LoadState :loading="!ready && !problem" :problem="ready ? '' : problem" :ready="ready" :empty="none" :lines="8" @retry="schedules.load(); firings.refresh()">
      <CalendarGrid v-if="view !== 'agenda'" :view="view" :days="days" :by-day="byDay" :anchor="day" :today="today" :zone="zone" @open="show" @day="openDay" />
      <template v-else>
        <AgendaList :days="days" :by-day="byDay" :today="today" :zone="zone" @open="show" />
        <Empty
          v-if="entries.length === 0" :icon="filtered ? 'search' : 'calendar'" :title="filtered ? 'Nothing matches here' : 'Nothing in these two weeks'"
          :body="filtered ? 'Try another schedule or status, or clear the filters.' : 'Go on to the next two weeks, or back to see what ran.'"
        >
          <template #actions>
            <Button v-if="filtered" variant="secondary" @click="clear">Clear filters</Button>
            <Button v-else variant="secondary" icon="chevron-right" @click="step(1)">Next two weeks</Button>
          </template>
        </Empty>
      </template>
      <template #empty>
        <Empty icon="calendar" title="Nothing scheduled yet" body="Ask in any chat to run something later, once or repeating (“every Monday at 9:00, sum up last week’s orders”). Each schedule’s runs show here." />
      </template>
    </LoadState>

    <Dialog v-model:open="panelOpen" :title="open?.title ?? 'Run'" :description="open ? instantWords(open.at, zone, today) : ''" width="520px">
      <div v-if="open" class="panel" data-testid="schedule-entry-panel">
        <div class="facts">
          <Badge :tone="entryLook(open).tone" dot :live="entryLook(open).live" data-testid="entry-status">{{ entryLook(open).word }}</Badge>
          <span v-if="open.manual" class="note">Run by hand</span>
          <span class="runs">Runs <FnPill :name="open.fn" /></span>
        </div>
        <p v-if="open.summary" class="summary" data-testid="entry-summary">{{ open.summary }}</p>
        <p v-else-if="open.status === 'coming'" class="note">{{ open.paused ? 'Its schedule is paused, so this run won’t happen unless it is resumed.' : 'Planned. Skip it or change the schedule on its page.' }}</p>
        <details v-if="open.args !== undefined" class="args">
          <summary>The args it ran with</summary>
          <pre>{{ argsText(open) }}</pre>
        </details>
      </div>
      <template #footer>
        <a v-if="open" class="link" :href="host.href(scheduleTo(open))" data-testid="entry-schedule" @click="toSchedule($event, open)">Open the schedule</a>
        <a v-if="open" class="link primary" :href="targetHref(host, entryTarget(open))" data-testid="entry-open" @click="follow($event, open)">
          {{ open.run ? 'Open the run' : open.status === 'coming' ? 'Skip or change it' : 'See this run' }}
        </a>
      </template>
    </Dialog>
  </Frame>
</template>

<style scoped>
.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-3); margin-bottom: var(--space-4); }
.nav { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.range { margin: 0 0 0 var(--space-2); font-size: var(--text-lg); font-weight: var(--weight-strong); white-space: nowrap; font-variant-numeric: tabular-nums; }
.views { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.view {
  height: calc(var(--control-sm, 32px) - 6px); padding: 0 var(--space-3); border: 0; border-radius: calc(var(--radius) - 3px); background: transparent;
  color: var(--text-dim); font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer;
  transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.view:hover { color: var(--text); }
.view[aria-checked='true'] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.view:focus-visible { outline: none; box-shadow: var(--ring); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.filters > * { min-width: 150px; max-width: 220px; }
.admin-link, .link { color: var(--accent); font-size: var(--text-sm); font-weight: var(--weight-medium); text-decoration: none; }
.admin-link:hover, .link:hover { text-decoration: underline; }
.link.primary {
  display: inline-flex; align-items: center; height: var(--control, 36px); padding: 0 var(--space-4); border-radius: var(--radius); background: var(--accent); color: var(--on-accent);
}
.link.primary:hover { background: var(--accent-hover); text-decoration: none; }
.panel { display: grid; gap: var(--space-3); min-width: 0; }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
.runs { display: inline-flex; align-items: center; gap: var(--space-1); }
.summary { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); overflow-wrap: anywhere; }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.args summary { color: var(--text-dim); font-size: var(--text-sm); cursor: pointer; }
.args pre { margin: var(--space-2) 0 0; padding: var(--space-3); max-height: 240px; overflow: auto; border-radius: var(--radius); background: var(--code-bg); font-family: var(--mono); font-size: var(--text-xs); }
@media (max-width: 639.98px) {
  .toolbar { align-items: stretch; }
  .nav { width: 100%; }
  .range { flex: 1; font-size: var(--text-md); }
  .views { width: 100%; }
  .view { flex: 1; }
  .filters { width: 100%; }
  .filters > * { flex: 1 1 140px; max-width: none; }
}
</style>
