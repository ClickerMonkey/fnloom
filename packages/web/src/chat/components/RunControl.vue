<script setup lang="ts">
/**
 * The composer's one stop / pause / resume control. It reads "Stop" while work runs and "Resume" while it is paused,
 * and opens a small panel: when two or more fns run, a list of them with checkboxes ("All" by default), then Pause,
 * Resume and Cancel, each pressable only when the choice allows it. Paused with nothing to choose between, it resumes
 * at once. Each listed fn is a `FnPill`. It reports `control` with the runs to name (`undefined`: all of them).
 */
import { RUN_STATUS_WORDS, type RunId, type SessionControls } from '@harness/core';
import { computed, ref } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import { UiButton, UiPopover } from '../../ui/index.ts';
import { choosableRuns, controlPlan, toggleRun, type ControlVerb, type RunChoice } from '../logic/controls.ts';

const props = defineProps<{ controls: SessionControls | undefined; running: boolean; paused: boolean; stopping: boolean }>();
const emit = defineEmits<{ control: [verb: ControlVerb, runs: readonly RunId[] | undefined] }>();

const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const choice = ref<RunChoice>('all');
const runs = computed(() => choosableRuns(props.controls));
const VERBS = [
  { verb: 'pause', label: 'Pause', icon: 'pause' },
  { verb: 'resume', label: 'Resume', icon: 'play' },
  { verb: 'cancel', label: 'Cancel', icon: 'stop' },
] as const;
const plans = computed(() => VERBS.map((v) => ({ ...v, plan: controlPlan(props.controls, props.paused, choice.value, v.verb) })));
const unstoppable = computed(() => props.controls?.uncancellable.length ?? 0);
const chosen = (run: RunId): boolean => choice.value === 'all' || choice.value.has(run);

function press(event: MouseEvent): void {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) { anchor.value = target; }
  if (props.paused && !props.running && runs.value.length === 0) { emit('control', 'resume', undefined); return; }
  if (!open.value) { choice.value = 'all'; }
  open.value = !open.value;
}

function act(verb: ControlVerb, targets: readonly RunId[] | undefined): void {
  open.value = false;
  emit('control', verb, targets);
}
</script>

<template>
  <span v-if="running || paused" class="run-control">
    <UiButton
      size="sm" variant="secondary" :icon="paused && !running ? 'play' : 'stop'" :loading="stopping" :data-testid="paused && !running ? 'resume' : 'stop'"
      :aria-expanded="open ? 'true' : 'false'" @click="press"
    >
      {{ paused && !running ? 'Resume' : 'Stop' }}
    </UiButton>
    <UiPopover v-model:open="open" :anchor="anchor" side="top" align="end" label="Stop, pause or resume">
      <div class="panel" data-testid="run-control">
        <ul v-if="runs.length > 0" class="runs">
          <li>
            <label class="row all"><input type="checkbox" :checked="choice === 'all'" data-testid="control-all" @change="choice = 'all'" /> All</label>
          </li>
          <li v-for="run in runs" :key="run.run">
            <label class="row">
              <input type="checkbox" :checked="chosen(run.run)" :data-run="run.run" @change="choice = toggleRun(choice, run.run, runs)" />
              <FnPill class="fn" :name="run.fn" />
              <span class="status">{{ RUN_STATUS_WORDS[run.status] }}</span>
            </label>
          </li>
        </ul>
        <div class="verbs">
          <UiButton
            v-for="item in plans" :key="item.verb" size="sm" :variant="item.verb === 'cancel' ? 'danger' : 'secondary'" :icon="item.icon"
            :disabled="!item.plan.enabled" :data-verb="item.verb" @click="act(item.verb, item.plan.runs)"
          >
            {{ item.label }}
          </UiButton>
        </div>
        <p v-if="unstoppable > 0" class="note">{{ unstoppable }} run{{ unstoppable === 1 ? '' : 's' }} will finish</p>
      </div>
    </UiPopover>
  </span>
</template>

<style scoped>
.run-control { display: inline-flex; }
.panel { display: grid; gap: var(--space-2); width: min(300px, calc(100vw - 32px)); padding: var(--space-2); }
.runs { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; max-height: 40vh; overflow: auto; }
.row { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-2); border-radius: var(--radius); font-size: var(--text-sm); }
.row:hover { background: var(--surface-2); }
.all { font-weight: var(--weight-medium); }
.fn { min-width: 0; }
.status { margin-left: auto; color: var(--text-faint); font-size: var(--text-xs); }
.verbs { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.note { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
