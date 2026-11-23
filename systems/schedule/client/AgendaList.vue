<script setup lang="ts">
/**
 * The calendar's agenda (the default on a phone): the days that have firings, each under its heading ("Today",
 * "Tomorrow", "Mon, Nov 30"), each firing a row with its time, its status, the schedule and the fn it runs (a pill that
 * opens the fn) and, once it ran, its one-line summary. A row opens its entry (`open`).
 */
import { computed } from 'vue';
import { usePageHost } from './host.ts';
import { dayHeading, entryLook, timeWords, type CalendarEntry } from './logic.ts';

const props = defineProps<{
  days: readonly string[];
  byDay: ReadonlyMap<string, readonly CalendarEntry[]>;
  today: string;
  zone: string;
}>();
const emit = defineEmits<{ open: [entry: CalendarEntry] }>();

const host = usePageHost();
const { Badge, FnPill } = host.components;
const shown = computed(() => props.days.filter((day) => (props.byDay.get(day)?.length ?? 0) > 0));
</script>

<template>
  <div class="agenda" data-testid="schedule-agenda">
    <section v-for="day in shown" :key="day" class="day" :class="{ today: day === today, past: day < today }" :data-day="day">
      <h3 class="heading"><span class="word">{{ dayHeading(day, today) }}</span><span v-if="day === today" class="now" aria-hidden="true" /></h3>
      <ul class="rows">
        <li v-for="entry in byDay.get(day)" :key="entry.id" class="row" :class="{ paused: entry.paused, coming: entry.status === 'coming' }" :style="{ '--tint': entryLook(entry).colour }" data-testid="agenda-entry" :data-status="entry.status">
          <button type="button" class="open" :aria-label="`${entry.title}, ${entry.allDay ? 'all day' : timeWords(entry.at, zone)}: ${entryLook(entry).word}`" @click="emit('open', entry)">
            <span class="time">{{ entry.allDay ? 'All day' : timeWords(entry.at, zone) }}</span>
            <span class="bar" aria-hidden="true" />
            <span class="main">
              <span class="title">{{ entry.title }}</span>
              <span v-if="entry.summary" class="summary">{{ entry.summary }}</span>
            </span>
          </button>
          <span class="side">
            <Badge :tone="entryLook(entry).tone" dot :live="entryLook(entry).live">{{ entryLook(entry).word }}</Badge>
            <FnPill :name="entry.fn" />
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.agenda { display: grid; gap: var(--space-4); min-width: 0; }
.day { display: grid; gap: var(--space-2); min-width: 0; animation: ui-rise-in var(--medium, 200ms) var(--ease); }
.heading { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-dim); font-size: var(--text-sm); font-weight: var(--weight-strong); }
.today .heading { color: var(--accent); }
.now { flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 45%, transparent); }
.rows { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); padding-right: var(--space-4); transition: background var(--fast) var(--ease); }
.row + .row { border-top: 1px solid var(--border); }
.row:hover { background: var(--surface-2); }
.row.paused { opacity: 0.55; }
.open { display: grid; grid-template-columns: 76px 3px minmax(0, 1fr); align-items: center; gap: var(--space-3); min-width: 0; padding: var(--space-3) 0 var(--space-3) var(--space-4); border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.open:focus-visible { outline: none; box-shadow: inset var(--ring); border-radius: var(--radius-lg); }
.time { color: var(--text-dim); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { align-self: stretch; min-height: 28px; border-radius: 2px; background: var(--tint); }
.coming .bar { background: repeating-linear-gradient(to bottom, var(--tint) 0 4px, transparent 4px 7px); }
.main { display: grid; gap: 2px; min-width: 0; }
.title { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.summary { overflow: hidden; color: var(--text-dim); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); min-width: 0; }
@media (max-width: 639.98px) {
  .row { grid-template-columns: minmax(0, 1fr); padding: 0 var(--space-3) var(--space-3); }
  .open { grid-template-columns: 64px 3px minmax(0, 1fr); padding: var(--space-3) 0 var(--space-1) 0; }
  .side { justify-content: flex-start; padding-left: calc(64px + 3px + 2 * var(--space-3)); }
}
@media (prefers-reduced-motion: reduce) { .day { animation: none; } }
</style>
