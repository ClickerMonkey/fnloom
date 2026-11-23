<script setup lang="ts">
/**
 * One schedule (`/s/schedule/item/<schedule>`): what it runs (a pill that opens the fn) and when in words, its zone
 * when it isn't the viewer's, when it notifies, its args, its next runs (each can be skipped) and the runs it skips;
 * its history (`?tab=history`, paged, each run with its summary and a link to its run page; `?firing=<key>` opens one);
 * and Run now, Pause, Resume, Edit (`?edit=1`) and Remove. Every change runs the schedule fns as the person through
 * the page's runs (`host.runs`), so approvals and undo are the same as in a chat; an approval waits on the page.
 */
import { Json, type QualifiedName, type Remember, type RunId } from '@harness/core';
import type { PageViewOf } from '@harness/sdk';
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { ScheduleContract } from '../shared/index.ts';
import { firingOf, fromOccurrenceKey } from '../shared/when.ts';
import { plainClick } from './host.ts';
import {
  changeArgsOf, comingFirings, draftOf, fixedArgsOf, instantWords, itemUrl, NOTIFY_WORDS, pausedOn, saysOf, SCHEDULE_FNS, SCHEDULE_PAGES, scheduleNameOf, STATUS_LOOK,
  todayIn, viewerZone, type ScheduleDraft,
} from './logic.ts';
import ScheduleForm from './ScheduleForm.vue';
import { ScheduleStore } from './state.ts';
import { FiringStatus } from '../shared/index.ts';

const props = defineProps<PageViewOf<ScheduleContract>>();
const host = props.host;
const { Frame, Button, Select, Badge, FnPill, Banner, Empty, Skeleton, Dialog, Approval, ValueEditor, LoadState } = host.components;

const zone = computed(() => viewerZone(host.user.timeZone));
const now = ref(Date.now());
const today = computed(() => todayIn(zone.value, now.value));
const url = computed(() => itemUrl(host.query.values));
const tab = computed(() => url.value.tab ?? 'overview');
const name = computed(() => scheduleNameOf(props.path));

const store = computed(() => (name.value === undefined ? undefined : new ScheduleStore({ hub: host.hub, runs: (options) => host.runs(options) }, name.value)));
watch(store, (next, before) => { before?.close(); void next?.open(); }, { immediate: true });
onBeforeUnmount(() => { store.value?.close(); });
host.live(() => { now.value = Date.now(); if (store.value?.busy.value === false) { void store.value.open(); } }, 30_000);

const item = computed(() => store.value?.item.value);
const payload = computed(() => item.value?.payload);
const title = computed(() => item.value?.title ?? 'Schedule');
const says = computed(() => (payload.value === undefined ? '' : saysOf(payload.value, zone.value, today.value)));
const paused = computed(() => payload.value !== undefined && pausedOn(payload.value, today.value));
const coming = computed(() => (item.value === undefined || paused.value ? [] : comingFirings(item.value, now.value, 3)));
const fixed = computed(() => (payload.value?.argsAsked === undefined ? fixedArgsOf(payload.value?.args) : undefined));
const argsType = computed(() => store.value?.target.value?.args);
/** Skipped runs still to come, by key. */
const skipped = computed(() => (payload.value?.when.exclude ?? []).filter((key) => key.slice(0, 10) >= today.value));

const calendarTo = { page: SCHEDULE_PAGES.calendar, path: [], query: {} };
function toCalendar(event: MouseEvent): void { if (plainClick(event)) { host.go(calendarTo); } }
function setTab(next: 'overview' | 'history'): void { host.query.set({ tab: next === 'overview' ? undefined : next }); }

// ── history ───────────────────────────────────────────────────────────────────

const statusChoices = [{ value: '', label: 'Any status' }, ...FiringStatus.options.map((status) => ({ value: status, label: STATUS_LOOK[status].word }))];
const historyStatus = host.query.bind('status');
watch(() => [store.value, tab.value, url.value.status] as const, ([current, shown, status]) => {
  if (current !== undefined && shown === 'history') { void current.showHistory(status); }
}, { immediate: true });
watch(() => [store.value, url.value.firing] as const, ([current, key]) => { void current?.openFiring(key); }, { immediate: true });
const opened = computed(() => (url.value.firing === undefined ? undefined : store.value?.opened.value));
/** A firing a link opened that has no record yet: a coming one, from the schedule itself. */
const openedComing = computed(() => {
  const key = url.value.firing;
  if (key === undefined || opened.value !== undefined || payload.value === undefined) { return undefined; }
  return firingOf(payload.value.when, payload.value.zone, key);
});
const firingOpen = computed({
  get: () => url.value.firing !== undefined,
  set: (open: boolean) => { if (!open) { host.query.set({ firing: undefined }); } },
});
function runLink(event: MouseEvent, run: RunId): void { if (plainClick(event)) { host.goRun(run); } }
function openFiring(event: MouseEvent, key: string): void { if (plainClick(event)) { host.query.set({ firing: key }, { push: true }); } }
async function skipOpened(key: string): Promise<void> { if (await skip(key)) { firingOpen.value = false; } }

// ── actions ───────────────────────────────────────────────────────────────────

async function act(fn: QualifiedName, args: Record<string, Json>, label: string, done: string): Promise<boolean> {
  const current = store.value;
  if (current === undefined) { return false; }
  const outcome = await current.act(fn, args, label);
  if (outcome.ok) { host.notify.ok(done); } else { host.notify.error(`Couldn't ${label.toLowerCase()}`, outcome.problem); }
  return outcome.ok;
}

const pause = () => act(SCHEDULE_FNS.pause, { schedule: name.value ?? '' }, 'Pause it', 'Paused');
const resume = () => act(SCHEDULE_FNS.resume, { schedule: name.value ?? '' }, 'Resume it', 'Resumed');
async function runNow(): Promise<void> {
  const current = store.value;
  if (current === undefined || name.value === undefined) { return; }
  const outcome = await current.act(name.value, {}, 'Run it now');
  if (outcome.ok) { host.notify.ok('It ran', 'Its result is in its history.'); setTab('history'); } else { host.notify.error("Couldn't run it", outcome.problem); }
}
function skip(key: string): Promise<boolean> {
  const { day, time } = fromOccurrenceKey(key);
  return act(SCHEDULE_FNS.skip, { schedule: name.value ?? '', day, ...(time === undefined ? {} : { time }) }, 'Skip that run', 'Skipped');
}
function unskip(key: string): Promise<boolean> {
  const when = payload.value?.when;
  if (when === undefined) { return Promise.resolve(false); }
  const exclude = (when.exclude ?? []).filter((k) => k !== key);
  const { exclude: _drop, ...rest } = when;
  return act(SCHEDULE_FNS.change, { schedule: name.value ?? '', when: Json.parse(exclude.length === 0 ? rest : { ...rest, exclude }) }, 'Bring that run back', 'It runs again');
}

const removing = ref(false);
async function remove(): Promise<void> {
  if (await act(SCHEDULE_FNS.remove, { schedule: name.value ?? '' }, 'Remove it', 'Removed')) {
    removing.value = false;
    host.go(calendarTo);
  }
}

async function decide(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<void> {
  if (!(await (store.value?.decide(approve, remember, reason, answer) ?? Promise.resolve(false)))) { host.notify.error("Couldn't send your answer", store.value?.actProblem.value); }
}

// ── editing ───────────────────────────────────────────────────────────────────

const draft = shallowRef<ScheduleDraft | undefined>(undefined);
const problems = ref<Readonly<Record<string, string>>>({});
const editing = computed({
  get: () => url.value.edit === '1' && item.value !== undefined,
  set: (open: boolean) => { host.query.set({ edit: open ? '1' : undefined }, { push: open }); },
});
watch(() => [editing.value, item.value] as const, ([open, current]) => {
  if (open && current !== undefined && draft.value === undefined) { draft.value = draftOf(current.payload, today.value); problems.value = {}; }
  if (!open) { draft.value = undefined; }
}, { immediate: true });

async function save(): Promise<void> {
  const current = item.value;
  if (current === undefined || draft.value === undefined) { return; }
  const checked = changeArgsOf(current, draft.value);
  if (!checked.ok) { problems.value = checked.problems; return; }
  problems.value = {};
  if (checked.args === undefined) { editing.value = false; return; }
  if (await act(SCHEDULE_FNS.change, checked.args, 'Save the changes', 'Saved')) { editing.value = false; }
}

const look = (status: FiringStatus) => STATUS_LOOK[status];
const busy = computed(() => store.value?.busy.value ?? false);
</script>

<template>
  <Frame :title="title" keep-title width="wide">
    <template #crumb><a :href="host.href(calendarTo)" @click="toCalendar">Schedule</a></template>
    <template v-if="item" #actions>
      <Button size="sm" variant="secondary" icon="play" :loading="store?.acting.value === 'Run it now'" :disabled="busy" data-testid="schedule-run-now" @click="runNow">Run now</Button>
      <Button v-if="payload?.paused" size="sm" variant="secondary" icon="play" :disabled="busy" data-testid="schedule-resume" @click="resume">Resume</Button>
      <Button v-else size="sm" variant="secondary" icon="pause" :disabled="busy" data-testid="schedule-pause" @click="pause">Pause</Button>
      <Button size="sm" variant="primary" icon="edit" :disabled="busy" data-testid="schedule-edit" @click="editing = true">Edit</Button>
      <Button size="sm" variant="ghost" icon="trash" aria-label="Remove" :disabled="busy" data-testid="schedule-remove" @click="removing = true" />
    </template>

    <Skeleton v-if="store === undefined || store.loading.value" shape="lines" :lines="6" />
    <Empty v-else-if="store.missing.value" icon="calendar" title="No such schedule of yours" body="It may have been removed, or belong to someone else.">
      <template #actions><a :href="host.href(calendarTo)" @click="toCalendar">Back to the calendar</a></template>
    </Empty>
    <Banner v-else-if="item === undefined || payload === undefined" tone="danger">{{ store.problem.value || "Couldn't read this schedule." }}</Banner>

    <div v-else class="page" data-testid="schedule-item">
      <section v-if="store.approval.value" class="waiting" aria-label="Waiting for you">
        <Approval :approval="store.approval.value" in-chat description="Changing a schedule is yours to approve, as in a chat." @decide="decide" />
      </section>
      <p v-else-if="store.phase.value === 'running'" class="note" aria-live="polite">{{ store.acting.value }}…</p>
      <Banner v-if="store.actProblem.value" tone="danger">{{ store.actProblem.value }}</Banner>
      <Banner v-if="paused" tone="warn" icon="pause" data-testid="schedule-paused">
        Paused{{ payload.paused?.until ? ` until ${payload.paused.until}` : '' }}: nothing runs until it is resumed.
      </Banner>

      <div class="tabs" role="tablist" aria-label="Schedule">
        <button type="button" role="tab" class="tab" :aria-selected="tab === 'overview'" data-testid="tab-overview" @click="setTab('overview')">Overview</button>
        <button type="button" role="tab" class="tab" :aria-selected="tab === 'history'" data-testid="tab-history" @click="setTab('history')">History</button>
      </div>

      <div v-if="tab === 'overview'" class="overview">
        <section class="card says-card">
          <p class="says" data-testid="schedule-says">{{ says }}</p>
          <dl class="facts">
            <div><dt>Runs</dt><dd><FnPill :name="payload.fn" data-testid="schedule-fn" /></dd></div>
            <div><dt>Notifies</dt><dd>{{ NOTIFY_WORDS[payload.notify] }}</dd></div>
            <div v-if="payload.maxSpend !== undefined"><dt>Cost cap</dt><dd>{{ host.format.cost(payload.maxSpend) }} a run</dd></div>
            <div v-if="payload.overlap !== 'skip'"><dt>Overlap</dt><dd>{{ payload.overlap === 'queue' ? 'A run due while one runs waits for it' : 'A run due while one runs stops it' }}</dd></div>
            <div v-if="payload.missed !== 'latest'"><dt>Missed runs</dt><dd>Not run late</dd></div>
          </dl>
        </section>

        <section class="card">
          <h3 class="card-title">Next runs</h3>
          <ul v-if="coming.length > 0" class="coming" data-testid="schedule-coming">
            <li v-for="firing in coming" :key="firing.key" class="coming-row">
              <span class="when">{{ instantWords(firing.at, zone, today) }}</span>
              <Button size="sm" variant="ghost" :disabled="busy" :data-testid="`skip-${firing.key}`" @click="skip(firing.key)">Skip</Button>
            </li>
          </ul>
          <p v-else class="note">{{ paused ? 'None while it is paused.' : 'It has no runs left.' }}</p>
          <template v-if="skipped.length > 0">
            <h4 class="sub">Skipped</h4>
            <ul class="coming">
              <li v-for="key in skipped" :key="key" class="coming-row skipped">
                <span class="when">{{ key.replace('T', ' at ') }}</span>
                <Button size="sm" variant="ghost" :disabled="busy" @click="unskip(key)">Bring back</Button>
              </li>
            </ul>
          </template>
        </section>

        <section class="card">
          <h3 class="card-title">Args</h3>
          <p v-if="payload.argsAsked" class="words" data-testid="schedule-args-words">{{ payload.argsAsked }}</p>
          <ValueEditor v-else-if="fixed !== undefined && argsType !== undefined" :type="argsType" :model-value="fixed" readonly />
          <pre v-else-if="fixed !== undefined" class="json">{{ JSON.stringify(fixed, null, 2) }}</pre>
          <p v-else class="note">Worked out for each run.</p>
          <p v-if="store.view.value?.firstArgs !== undefined" class="note">The next run gets: <code>{{ JSON.stringify(store.view.value.firstArgs) }}</code></p>
        </section>
      </div>

      <div v-else class="history" data-testid="schedule-history">
        <div class="bar">
          <Select v-model="historyStatus.value" :options="statusChoices" label="Status" hide-label size="sm" data-testid="history-status" />
        </div>
        <LoadState
          :loading="store.historyLoading.value && !store.historyLoaded.value" :problem="store.historyProblem.value" :ready="store.historyLoaded.value" :empty="store.history.value.length === 0"
          empty-icon="clock" :empty-title="url.status ? 'No runs with that status' : 'No runs yet'" :empty-body="url.status ? 'Try another status.' : 'Each run shows here once it is due, with how it went.'"
          @retry="store.showHistory(url.status)"
        >
          <ul class="runs">
            <li v-for="firing in store.history.value" :key="firing.id" class="run" :style="{ '--tint': look(firing.value.status).colour }" data-testid="history-row" :data-status="firing.value.status">
              <span class="bar-mark" aria-hidden="true" />
              <span class="main">
                <span class="top">
                  <span class="when">{{ instantWords(firing.value.at, zone, today) }}</span>
                  <Badge :tone="look(firing.value.status).tone" dot :live="look(firing.value.status).live">{{ look(firing.value.status).word }}</Badge>
                  <span v-if="firing.value.manual" class="tag">by hand</span>
                </span>
                <span v-if="firing.value.summary" class="summary">{{ firing.value.summary }}</span>
              </span>
              <a v-if="firing.value.run" class="link" :href="host.runHref(firing.value.run)" data-testid="history-run" @click="runLink($event, firing.value.run)">Open the run</a>
              <a v-else class="link" :href="host.href({ query: { tab: 'history', firing: firing.value.key } })" @click="openFiring($event, firing.value.key)">Details</a>
            </li>
          </ul>
          <div v-if="store.hasMore.value" class="more">
            <Button variant="ghost" size="sm" :loading="store.historyLoading.value" data-testid="history-more" @click="store.more(url.status)">Show more</Button>
          </div>
        </LoadState>
      </div>
    </div>

    <Dialog v-model:open="firingOpen" :title="opened ? STATUS_LOOK[opened.value.status].word : openedComing ? 'A coming run' : 'A run'" :description="opened ? instantWords(opened.value.at, zone, today) : openedComing ? instantWords(openedComing.at, zone, today) : ''" width="480px">
      <div class="panel" data-testid="schedule-firing">
        <template v-if="opened">
          <p v-if="opened.value.summary" class="summary-box">{{ opened.value.summary }}</p>
          <p v-if="opened.value.manual" class="note">Run by hand.</p>
          <pre v-if="opened.value.args !== undefined" class="json">{{ JSON.stringify(opened.value.args, null, 2) }}</pre>
        </template>
        <template v-else-if="openedComing">
          <p class="note">{{ paused ? 'Planned, but the schedule is paused.' : 'Planned. Skip it if it shouldn’t run.' }}</p>
        </template>
        <p v-else class="note">This run isn’t in its history.</p>
      </div>
      <template #footer>
        <Button v-if="openedComing" variant="secondary" :disabled="busy" data-testid="firing-skip" @click="skipOpened(openedComing.key)">Skip this run</Button>
        <a v-if="opened?.value.run" class="link" :href="host.runHref(opened.value.run)" @click="runLink($event, opened.value.run)">Open the run</a>
      </template>
    </Dialog>

    <Dialog v-model:open="editing" :title="`Edit ${title}`" description="Saving makes a new version; Undo in its chat goes back." width="640px">
      <div class="dialog" data-testid="schedule-edit-dialog">
        <ScheduleForm v-if="draft" v-model="draft" :args-type="argsType" :problems="problems" :disabled="busy" :zone="zone" :today="today" />
        <Approval v-if="store?.approval.value" :approval="store.approval.value" in-chat description="Changing a schedule is yours to approve, as in a chat." @decide="decide" />
      </div>
      <template #footer>
        <Button variant="ghost" @click="editing = false">Cancel</Button>
        <Button variant="primary" icon="check" :loading="store?.acting.value === 'Save the changes'" data-testid="schedule-save" @click="save">Save</Button>
      </template>
    </Dialog>

    <Dialog v-model:open="removing" :title="`Remove ${title}?`" description="It never runs again. Its past runs stay in its history, and Undo in its chat brings it back." width="440px">
      <template #footer>
        <Button variant="ghost" @click="removing = false">Keep it</Button>
        <Button variant="danger" icon="trash" :loading="store?.acting.value === 'Remove it'" data-testid="schedule-remove-confirm" @click="remove">Remove</Button>
      </template>
    </Dialog>
  </Frame>
</template>

<style scoped>
.page { display: grid; gap: var(--space-4); min-width: 0; }
.waiting { display: grid; gap: var(--space-3); }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.tabs { display: flex; gap: var(--space-4); border-bottom: 1px solid var(--border); }
.tab { position: relative; padding: var(--space-2) 0; border: 0; background: none; color: var(--text-dim); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
.tab[aria-selected='true'] { color: var(--text); }
.tab[aria-selected='true']::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 2px; background: var(--accent); }
.tab:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--radius-sm); }
.overview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
.card { display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); }
.says-card { grid-column: 1 / -1; background: linear-gradient(135deg, var(--accent-soft), var(--surface) 70%); }
.says { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
.facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-6); margin: 0; }
.facts div { display: grid; gap: 2px; }
.facts dt { color: var(--text-dim); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.facts dd { display: flex; align-items: center; margin: 0; font-size: var(--text-sm); }
.card-title { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.sub { margin: var(--space-2) 0 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.04em; }
.coming { display: grid; margin: 0; padding: 0; list-style: none; }
.coming-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-1) 0; font-variant-numeric: tabular-nums; }
.coming-row + .coming-row { border-top: 1px solid var(--border); }
.coming-row.skipped .when { color: var(--text-faint); text-decoration: line-through; }
.words { margin: 0; padding: var(--space-3); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface-2); font-style: italic; }
.json { margin: 0; padding: var(--space-3); max-height: 260px; overflow: auto; border-radius: var(--radius); background: var(--code-bg); font-family: var(--mono); font-size: var(--text-xs); }
.history { display: grid; gap: var(--space-3); min-width: 0; }
.bar { display: flex; }
.bar > * { min-width: 180px; }
.runs { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.run { display: grid; grid-template-columns: 3px minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); animation: ui-rise-in var(--medium, 200ms) var(--ease); }
.run + .run { border-top: 1px solid var(--border); }
.bar-mark { align-self: stretch; min-height: 28px; border-radius: 2px; background: var(--tint); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.when { font-size: var(--text-sm); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
.tag { color: var(--text-faint); font-size: var(--text-xs); }
.summary { color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.link { color: var(--accent); font-size: var(--text-sm); font-weight: var(--weight-medium); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.more { display: flex; justify-content: center; }
.panel, .dialog { display: grid; gap: var(--space-3); min-width: 0; }
.summary-box { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); overflow-wrap: anywhere; }
@media (max-width: 759.98px) { .overview { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 519.98px) { .run { grid-template-columns: 3px minmax(0, 1fr); } .run > .link { grid-column: 2; } }
@media (prefers-reduced-motion: reduce) { .run { animation: none; } }
</style>
