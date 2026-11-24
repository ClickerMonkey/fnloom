<script setup lang="ts">
/**
 * The calendar grid, the system's own component (docs/plans/schedule-system.md, "The schedule page"): a month of whole
 * weeks or one week, Sunday first, each day with its firings as chips in their status colour (time and schedule,
 * faded when the schedule is paused). On a phone the month shows a dot per firing and a tap opens that day's agenda;
 * the week scrolls one day at a time, opening on today (or the week's first day when today isn't in it). A chip opens
 * its entry (`open`), a day's number its agenda (`day`).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { cellNumber, entryLook, SHORT_WEEKDAYS, timeWords, type CalendarEntry, type CalendarView } from './logic.ts';

const props = defineProps<{
  view: Exclude<CalendarView, 'agenda'>;
  days: readonly string[];
  byDay: ReadonlyMap<string, readonly CalendarEntry[]>;
  /** The day the view is about (its month's days are drawn full, the others faint). */
  anchor: string;
  today: string;
  zone: string;
}>();
const emit = defineEmits<{ open: [entry: CalendarEntry]; day: [day: string] }>();

/** How many chips a month cell shows before "+N more". */
const SHOWN = 3;
/** How many dots a phone's month cell shows. */
const DOTS = 4;

const month = computed(() => props.anchor.slice(0, 7));
const weeks = computed(() => Array.from({ length: Math.ceil(props.days.length / 7) }, (_, i) => props.days.slice(i * 7, i * 7 + 7)));
const entriesOn = (day: string): readonly CalendarEntry[] => props.byDay.get(day) ?? [];
const chipTime = (entry: CalendarEntry): string => (entry.allDay ? 'All day' : timeWords(entry.at, props.zone));
const label = (entry: CalendarEntry): string => `${chipTime(entry)}, ${entry.title}: ${entryLook(entry).word}`;
/** The grid, to scroll a phone's week to its day. */
const grid = ref<HTMLElement | null>(null);
/** On a phone the week scrolls sideways: bring today's column (else the first) to the start. Wider, nothing scrolls. */
async function toDay(): Promise<void> {
  await nextTick();
  const el = grid.value;
  if (props.view !== 'week' || el === null || el.scrollWidth <= el.clientWidth) { return; }
  const day = props.days.includes(props.today) ? props.today : props.days[0];
  const cell = el.querySelector<HTMLElement>(`[data-day="${day ?? ''}"]`);
  el.scrollLeft = cell === null ? 0 : el.scrollLeft + cell.getBoundingClientRect().left - el.getBoundingClientRect().left - el.clientLeft;
}
onMounted(() => { void toDay(); });
watch(() => [props.view, props.days[0]], () => { void toDay(); });
const dayLabel = (day: string): string => {
  const count = entriesOn(day).length;
  return `${day}: ${count === 0 ? 'nothing planned' : `${String(count)} ${count === 1 ? 'run' : 'runs'}`}`;
};
</script>

<template>
  <div ref="grid" class="grid" :class="view" role="grid" :aria-label="view === 'month' ? 'Month' : 'Week'" data-testid="schedule-grid" :data-view="view">
    <div class="head" role="row">
      <span v-for="(name, i) in SHORT_WEEKDAYS" :key="name" class="weekday" role="columnheader" :data-weekend="i === 0 || i === 6">{{ name }}</span>
    </div>
    <div v-for="(week, w) in weeks" :key="w" class="row" role="row">
      <div
        v-for="day in week" :key="day" class="cell" role="gridcell" :data-day="day"
        :class="{ out: view === 'month' && day.slice(0, 7) !== month, today: day === today, past: day < today }"
      >
        <button type="button" class="number" :aria-label="dayLabel(day)" data-testid="grid-day" @click="emit('day', day)">
          <span class="weekday-inline">{{ SHORT_WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] }}</span>
          <span class="n">{{ view === 'month' ? cellNumber(day) : day.slice(8, 10).replace(/^0/, '') }}</span>
        </button>
        <ul class="chips">
          <li v-for="entry in (view === 'month' ? entriesOn(day).slice(0, SHOWN) : entriesOn(day))" :key="entry.id">
            <button
              type="button" class="chip" :class="{ paused: entry.paused, coming: entry.status === 'coming', live: entryLook(entry).live }"
              :style="{ '--tint': entryLook(entry).colour }" :title="label(entry)" :aria-label="label(entry)" data-testid="grid-entry" :data-status="entry.status"
              @click="emit('open', entry)"
            >
              <span class="time">{{ chipTime(entry) }}</span>
              <span class="what">{{ entry.title }}</span>
            </button>
          </li>
        </ul>
        <button v-if="view === 'month' && entriesOn(day).length > SHOWN" type="button" class="more" data-testid="grid-more" @click="emit('day', day)">
          +{{ entriesOn(day).length - SHOWN }} more
        </button>
        <button v-if="view === 'month' && entriesOn(day).length > 0" type="button" class="dots" :aria-label="dayLabel(day)" @click="emit('day', day)">
          <span v-for="entry in entriesOn(day).slice(0, DOTS)" :key="entry.id" class="dot" :class="{ paused: entry.paused, coming: entry.status === 'coming' }" :style="{ '--tint': entryLook(entry).colour }" />
          <span v-if="entriesOn(day).length > DOTS" class="plus">+</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden; }
.head, .row { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.head { border-bottom: 1px solid var(--border); background: var(--surface-2); }
.weekday { padding: var(--space-2); color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-medium); text-align: center; text-transform: uppercase; letter-spacing: 0.04em; }
.row + .row { border-top: 1px solid var(--border); }
.cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; min-height: 112px; padding: var(--space-1); }
.cell + .cell { border-left: 1px solid var(--border); }
.row .cell { animation: ui-rise-in var(--medium, 200ms) var(--ease); }
.cell.out { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
.cell.out .n { color: var(--text-faint); }
.grid.week .cell { min-height: 320px; }
.number {
  display: inline-flex; align-items: baseline; gap: var(--space-1); align-self: flex-start; padding: 2px var(--space-2); border: 0; border-radius: var(--radius-full);
  background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); font-variant-numeric: tabular-nums; cursor: pointer;
}
.number:hover { background: var(--surface-2); }
.number:focus-visible, .chip:focus-visible, .more:focus-visible, .dots:focus-visible { outline: none; box-shadow: var(--ring); }
.today .number { background: var(--accent); color: var(--on-accent); font-weight: var(--weight-strong); }
.today .number .n, .today .number .weekday-inline { color: var(--on-accent); }
.weekday-inline { display: none; color: var(--text-dim); font-size: var(--text-xs); text-transform: uppercase; }
.chips { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.chips > li { min-width: 0; }
.chip {
  /* border-box, so its padding and border stay inside the day's column */
  display: flex; box-sizing: border-box; align-items: baseline; gap: var(--space-1); width: 100%; min-width: 0; overflow: hidden; padding: 2px var(--space-2); border: 0; border-left: 3px solid var(--tint);
  border-radius: var(--radius-sm); background: color-mix(in srgb, var(--tint) 14%, var(--surface)); color: var(--text); font: inherit; font-size: var(--text-xs);
  text-align: left; cursor: pointer; transition: background var(--fast) var(--ease), transform var(--fast) var(--ease);
}
.chip:hover { background: color-mix(in srgb, var(--tint) 24%, var(--surface)); }
.chip:active { transform: scale(0.98); }
/* a coming firing is a promise, not a fact: outlined, not filled */
.chip.coming { background: transparent; border: 1px dashed color-mix(in srgb, var(--tint) 55%, var(--border)); border-left: 3px solid var(--tint); }
.chip.paused { opacity: 0.5; }
.chip.live .time::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--tint); animation: pulse 1.4s ease-in-out infinite; vertical-align: middle; }
.time { flex: none; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
.more { align-self: flex-start; padding: 0 var(--space-2); border: 0; background: none; color: var(--text-dim); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.more:hover { color: var(--accent); }
.dots { display: none; }
@keyframes pulse { 50% { opacity: 0.35; } }

/* a week: each day a column of its runs, the time on its own line */
.grid.week .chip { flex-direction: column; align-items: flex-start; gap: 0; padding: var(--space-1) var(--space-2); }
.grid.week .what { white-space: normal; overflow-wrap: anywhere; }

@media (max-width: 639.98px) {
  /* a phone's month: dots, and a tap opens the day */
  .grid.month .cell { min-height: 56px; align-items: center; padding: var(--space-1) 0; }
  .grid.month .chips, .grid.month .more { display: none; }
  .grid.month .number { padding: 2px 6px; }
  .grid.month .dots { display: flex; flex-wrap: wrap; justify-content: center; gap: 3px; padding: 2px; border: 0; background: none; cursor: pointer; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tint); }
  .dot.coming { background: transparent; box-shadow: inset 0 0 0 1.5px var(--tint); }
  .dot.paused { opacity: 0.45; }
  .plus { color: var(--text-dim); font-size: 10px; line-height: 6px; }
  .weekday { padding: var(--space-1) 0; font-size: 10px; }
  /* a phone's week: one day at a time, swiped */
  .grid.week { overflow-x: auto; scroll-snap-type: x mandatory; }
  .grid.week .head { display: none; }
  .grid.week .row { grid-template-columns: repeat(7, 86%); }
  .grid.week .cell { scroll-snap-align: start; min-height: 260px; }
  .grid.week .weekday-inline { display: inline; }
}
@media (prefers-reduced-motion: reduce) { .chip.live .time::before { animation: none; } .row .cell { animation: none; } }
</style>
