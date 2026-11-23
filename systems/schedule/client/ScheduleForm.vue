<script setup lang="ts">
/**
 * A schedule's edit form, one column (docs/plans/schedule-system.md, "The schedule page"): when it runs (presets
 * built from dayspan's patterns for the day picked, or custom days of the week and month, every N weeks), its times
 * of day and zone, how it ends; its args (the fn's args type in the app's value editor for fixed values, or the words
 * that work them out for each run); when the person is notified; and, under "More", overlap, missed runs and a cost
 * cap. While it is typed the form says the schedule in words and lists its next runs, worked out here by the same
 * code the server plans with.
 */
import { Json } from '@harness/core';
import { computed } from 'vue';
import { z } from 'zod';
import { Missed, Notify, Overlap } from '../shared/index.ts';
import { describeWhen, nextFirings, PRESET_IDS } from '../shared/when.ts';
import { usePageHost } from './host.ts';
import {
  instantWords, MISSED_CHOICES, NOTIFY_CHOICES, OVERLAP_CHOICES, presetChoices, SHORT_WEEKDAYS, whenOfDraft, zoneChoices, type ScheduleDraft,
} from './logic.ts';

const props = defineProps<{
  /** The args type of the fn it runs (a gin type), for the value editor; absent when the hub didn't give one. */
  argsType?: unknown;
  problems?: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** The viewer's zone and day, for the preview. */
  zone: string;
  today: string;
}>();
const draft = defineModel<ScheduleDraft>({ required: true });

const host = usePageHost();
const { Select, Input, Textarea, Button, ValueEditor, Icon } = host.components;

const presets = computed(() => presetChoices(draft.value.day));
const zones = computed(() => zoneChoices(draft.value.zone));
const ENDS = [{ value: 'never', label: 'Never' }, { value: 'on', label: 'On a day' }, { value: 'after', label: 'After a number of runs' }];
const ENDS_KIND = z.enum(['never', 'on', 'after']);
const once = computed(() => draft.value.preset === 'once');
const custom = computed(() => draft.value.preset === 'custom');

const checked = computed(() => whenOfDraft(draft.value));
const words = computed(() => (checked.value.ok ? describeWhen(checked.value.when, draft.value.zone, { viewerZone: props.zone, today: props.today }) : ''));
const coming = computed(() => (checked.value.ok ? nextFirings(checked.value.when, draft.value.zone, Date.now(), 3) : []));
const problemOf = (field: string): string | undefined => props.problems?.[field] ?? (checked.value.ok ? undefined : checked.value.problems[field]);

/** Change one field of the draft (a new object, so the page's model sees it). */
function set<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]): void {
  draft.value = { ...draft.value, [key]: value };
}
function setPreset(value: string): void {
  const preset = PRESET_IDS.find((id) => id === value);
  if (preset === undefined) { return; }
  // leaving custom drops rules the form couldn't edit; a preset is worded for the day picked
  draft.value = { ...draft.value, preset, kept: preset === 'custom' ? draft.value.kept : undefined };
}
function setNotify(value: string): void { const parsed = Notify.safeParse(value); if (parsed.success) { set('notify', parsed.data); } }
function setOverlap(value: string): void { const parsed = Overlap.safeParse(value); if (parsed.success) { set('overlap', parsed.data); } }
function setMissed(value: string): void { const parsed = Missed.safeParse(value); if (parsed.success) { set('missed', parsed.data); } }
function setEnds(value: string): void { const parsed = ENDS_KIND.safeParse(value); if (parsed.success) { set('ends', parsed.data); } }
function setTime(at: number, value: string): void { set('times', draft.value.times.map((time, i) => (i === at ? value : time))); }
function addTime(): void { set('times', [...draft.value.times, draft.value.times.at(-1) === undefined ? '09:00' : nextHour(draft.value.times.at(-1) ?? '09:00')]); }
function removeTime(at: number): void { set('times', draft.value.times.filter((_, i) => i !== at)); }
function toggleWeekday(day: number): void {
  const has = draft.value.weekdays.includes(day);
  set('weekdays', has ? draft.value.weekdays.filter((d) => d !== day) : [...draft.value.weekdays, day].sort());
}
/** An hour after a time, for the next time added (wrapping at midnight). */
function nextHour(time: string): string {
  const hour = (Number(time.slice(0, 2)) + 1) % 24;
  return `${String(hour).padStart(2, '0')}${time.slice(2)}`;
}
const inputValue = (event: Event): string => (event.target instanceof HTMLInputElement ? event.target.value : '');
const editorValue = computed({ get: () => draft.value.args, set: (value: Json | undefined) => { set('args', value); } });
const argsJson = computed({
  get: () => (draft.value.args === undefined ? '' : JSON.stringify(draft.value.args, null, 2)),
  set: (text: string) => { try { set('args', text.trim() === '' ? undefined : Json.parse(JSON.parse(text))); } catch { /* kept as typed until it reads */ } },
});
</script>

<template>
  <div class="form" data-testid="schedule-form">
    <section class="part" aria-labelledby="when-heading">
      <h3 id="when-heading" class="part-title">When</h3>
      <div class="row two">
        <label class="field">
          <span class="label">{{ once ? 'Day' : 'Starts' }}</span>
          <input class="native" type="date" :value="draft.day" :disabled="disabled" data-testid="form-day" @input="set('day', inputValue($event))">
          <span v-if="problemOf('day')" class="error">{{ problemOf('day') }}</span>
        </label>
        <Select :model-value="draft.preset" :options="presets" label="Repeats" :disabled="disabled" :error="problemOf('preset')" data-testid="form-preset" @update:model-value="setPreset" />
      </div>

      <div v-if="custom" class="custom" data-testid="form-custom">
        <p v-if="draft.kept" class="hint">It uses rules this form can’t edit; they stay as they are. Pick a repeat above to replace them.</p>
        <template v-else>
          <div class="field">
            <span class="label">Days of the week</span>
            <div class="weekdays" role="group" aria-label="Days of the week">
              <button
                v-for="(name, i) in SHORT_WEEKDAYS" :key="name" type="button" class="weekday" :aria-pressed="draft.weekdays.includes(i) ? 'true' : 'false'" :disabled="disabled"
                :data-testid="`form-weekday-${i}`" @click="toggleWeekday(i)"
              >
                {{ name.slice(0, 2) }}
              </button>
            </div>
            <span v-if="problemOf('weekdays')" class="error">{{ problemOf('weekdays') }}</span>
          </div>
          <div class="row two">
            <Input :model-value="draft.monthDays" label="Days of the month" placeholder="1, 15" :disabled="disabled" :error="problemOf('monthDays')" @update:model-value="(v: string) => set('monthDays', v)" />
            <Input :model-value="draft.everyWeeks" type="number" label="Every how many weeks" placeholder="1" :disabled="disabled" :error="problemOf('everyWeeks')" @update:model-value="(v: string) => set('everyWeeks', v)" />
          </div>
        </template>
      </div>

      <div class="field">
        <span class="label">Times of day</span>
        <div class="times">
          <span v-for="(time, i) in draft.times" :key="i" class="time">
            <input class="native" type="time" :value="time" :aria-label="`Time ${i + 1}`" :disabled="disabled" :data-testid="`form-time-${i}`" @input="setTime(i, inputValue($event))">
            <button type="button" class="remove" :aria-label="`Remove ${time}`" :disabled="disabled" @click="removeTime(i)"><Icon name="x" :size="14" /></button>
          </span>
          <Button variant="ghost" size="sm" icon="plus" :disabled="disabled" data-testid="form-add-time" @click="addTime">Add a time</Button>
        </div>
        <span v-if="draft.times.length === 0" class="hint">No times: it runs once at the start of the day (00:00).</span>
        <span v-if="problemOf('times')" class="error">{{ problemOf('times') }}</span>
      </div>

      <div class="row two">
        <Select :model-value="draft.zone" :options="zones" label="Time zone" :disabled="disabled" :error="problemOf('zone')" data-testid="form-zone" @update:model-value="(v: string) => set('zone', v)" />
        <template v-if="!once">
          <Select :model-value="draft.ends" :options="ENDS" label="Ends" :disabled="disabled" @update:model-value="setEnds" />
        </template>
      </div>
      <div v-if="!once && draft.ends !== 'never'" class="row two">
        <label v-if="draft.ends === 'on'" class="field">
          <span class="label">Last day</span>
          <input class="native" type="date" :value="draft.endDay" :disabled="disabled" @input="set('endDay', inputValue($event))">
          <span v-if="problemOf('endDay')" class="error">{{ problemOf('endDay') }}</span>
        </label>
        <Input v-else :model-value="draft.count" type="number" label="How many runs" :disabled="disabled" :error="problemOf('count')" @update:model-value="(v: string) => set('count', v)" />
      </div>

      <div class="preview" aria-live="polite" data-testid="form-preview">
        <template v-if="checked.ok">
          <p class="says"><Icon name="calendar" :size="16" /> {{ words }}</p>
          <ol v-if="coming.length > 0" class="coming">
            <li v-for="firing in coming" :key="firing.key">{{ instantWords(firing.at, zone, today) }}</li>
          </ol>
          <p v-else class="hint">It has no runs left.</p>
        </template>
        <p v-else-if="problemOf('when')" class="error">{{ problemOf('when') }}</p>
      </div>
    </section>

    <section class="part" aria-labelledby="args-heading">
      <h3 id="args-heading" class="part-title">Args</h3>
      <div class="modes" role="radiogroup" aria-label="How the args are given">
        <button type="button" role="radio" class="mode" :aria-checked="draft.argsMode === 'fixed' ? 'true' : 'false'" :disabled="disabled" data-testid="form-args-fixed" @click="set('argsMode', 'fixed')">The same every run</button>
        <button type="button" role="radio" class="mode" :aria-checked="draft.argsMode === 'compute' ? 'true' : 'false'" :disabled="disabled" data-testid="form-args-compute" @click="set('argsMode', 'compute')">Worked out for each run</button>
      </div>
      <template v-if="draft.argsMode === 'fixed'">
        <ValueEditor v-if="argsType !== undefined" v-model="editorValue" :type="argsType" data-testid="form-args" />
        <Textarea v-else v-model="argsJson" label="Args (JSON)" :rows="4" :disabled="disabled" data-testid="form-args-json" />
      </template>
      <template v-else>
        <Textarea
          :model-value="draft.compute" label="How the args are worked out" placeholder="from: the run's day minus 7 days; to: the run's day" :rows="3" :disabled="disabled" :error="problemOf('compute')"
          hint="In plain words, from the run's day and time and the last run's result. Saving works them out and checks them." data-testid="form-compute"
          @update:model-value="(v: string) => set('compute', v)"
        />
      </template>
    </section>

    <section class="part" aria-labelledby="notify-heading">
      <h3 id="notify-heading" class="part-title">Notify me</h3>
      <Select :model-value="draft.notify" :options="NOTIFY_CHOICES" label="Notify me" hide-label :disabled="disabled" data-testid="form-notify" @update:model-value="setNotify" />
      <details class="more">
        <summary>More</summary>
        <div class="more-body">
          <Select :model-value="draft.overlap" :options="OVERLAP_CHOICES" label="When a run is due while the last one still runs" :disabled="disabled" @update:model-value="setOverlap" />
          <Select :model-value="draft.missed" :options="MISSED_CHOICES" label="Runs missed while the hub was down" :disabled="disabled" @update:model-value="setMissed" />
          <Input :model-value="draft.maxSpend" label="The most one run may spend (USD)" placeholder="No cap" :disabled="disabled" :error="problemOf('maxSpend')" data-testid="form-max-spend" @update:model-value="(v: string) => set('maxSpend', v)" />
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-5); min-width: 0; }
.part { display: grid; gap: var(--space-3); min-width: 0; }
.part-title { margin: 0; color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.05em; }
.row { display: grid; gap: var(--space-3); min-width: 0; }
.row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field { display: grid; gap: var(--space-1); min-width: 0; }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
.error { color: var(--danger); font-size: var(--text-xs); }
.native {
  height: var(--control, 36px); min-width: 0; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  color: var(--text); font: inherit; font-size: var(--text-sm); color-scheme: light dark;
}
.native:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.custom { display: grid; gap: var(--space-3); padding: var(--space-3); border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); }
.weekdays { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.weekday {
  width: 40px; height: 40px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); color: var(--text-dim); font: inherit; font-size: var(--text-sm);
  font-weight: var(--weight-medium); cursor: pointer; transition: background var(--fast) var(--ease), color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}
.weekday[aria-pressed='true'] { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.weekday:focus-visible { outline: none; box-shadow: var(--ring); }
.times { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.time { display: inline-flex; align-items: center; gap: 2px; padding-right: 2px; border-radius: var(--radius); }
.time .native { width: 128px; }
.remove { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: var(--radius-full); background: none; color: var(--text-dim); cursor: pointer; }
.remove:hover { background: var(--surface-2); color: var(--danger); }
.preview { display: grid; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--accent-soft); }
.says { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; font-weight: var(--weight-medium); }
.coming { display: grid; gap: 2px; margin: 0; padding-left: calc(16px + var(--space-2)); color: var(--text-dim); font-size: var(--text-sm); list-style: none; font-variant-numeric: tabular-nums; }
.modes { display: inline-flex; flex-wrap: wrap; gap: 2px; width: fit-content; max-width: 100%; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.mode { height: 30px; padding: 0 var(--space-3); border: 0; border-radius: calc(var(--radius) - 3px); background: transparent; color: var(--text-dim); font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer; }
.mode[aria-checked='true'] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.mode:focus-visible { outline: none; box-shadow: var(--ring); }
.more summary { color: var(--text-dim); font-size: var(--text-sm); cursor: pointer; }
.more-body { display: grid; gap: var(--space-3); padding-top: var(--space-3); }
@media (max-width: 559.98px) { .row.two { grid-template-columns: minmax(0, 1fr); } }
</style>
