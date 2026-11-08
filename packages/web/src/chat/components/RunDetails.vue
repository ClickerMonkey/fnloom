<script setup lang="ts">
/**
 * One run in full, in a side panel whose header names the fn (its name and id, so neither repeats here): its status and timing, cost (its own and with everything it called), progress,
 * args (by their gin type when it is known, so system components draw named types) and result (readable, and as JSON), why its input was refused (softly: the agent retries), the error of every failed attempt, where it came from (the LLM call that
 * asked for it, its parent) and what may be done with it now (move to the background, open the turn's tree, undo
 * the turn; for admins, its model calls). Live while the run is going.
 */
import type { GinTypeDef, Json, LlmInteractionId, Run, RunId } from '@harness/core';
import { computed } from 'vue';
import { UiBanner, UiButton, UiCodeBlock, UiSkeleton, UiTabs, fullTime, type TabItem } from '../../ui/index.ts';
import { formatCost, formatDuration } from '../logic/format.ts';
import { humanize } from '../logic/labels.ts';
import { isSettled } from '@harness/core';
import { argSummary, INPUT_PROBLEM_WORDS, resultBrief, runElapsed, runError, runInvalid, runResult, statusDetail, STATUS_LOOK, type RunView } from '../logic/runs.ts';
import type { RunTab as Tab } from '../logic/inspect.ts';
import GinValueView from '../../gin/GinValueView.vue';
import RunDot from './RunDot.vue';
import RunProgress from './RunProgress.vue';

const props = withDefaults(defineProps<{
  run: RunView | undefined;
  record?: Run | undefined;
  loading: boolean;
  problem?: string;
  now: number;
  /** Whether the person may see the run's model calls (admins: the model calls page is theirs). */
  canSeeCalls?: boolean;
  /** The gin type of the fn's args (`GinTypeDef`), when the browser knows it: the args then draw by their type, with system components for named types. */
  argsType?: GinTypeDef | undefined;
}>(), { record: undefined, problem: '', canSeeCalls: false, argsType: undefined });
const emit = defineEmits<{ background: []; tree: []; undo: []; llm: [id: LlmInteractionId]; run: [id: RunId]; retry: []; calls: [id: RunId] }>();

/** The tab shown; a parent binds it to the URL so a refresh keeps it. */
const tab = defineModel<Tab>('tab', { default: 'overview' });
const tabs = computed<TabItem<Tab>[]>(() => [
  { value: 'overview', label: 'Overview' },
  { value: 'args', label: 'Args' },
  { value: 'result', label: 'Result' },
  ...((props.run?.errors.length ?? 0) > 0 ? [{ value: 'errors' as const, label: 'Errors', count: props.run?.errors.length ?? 0 }] : []),
  { value: 'json', label: 'JSON' },
]);

const error = computed(() => (props.run === undefined ? undefined : runError(props.run)));
const invalid = computed(() => (props.run === undefined ? undefined : runInvalid(props.run)));
const result = computed(() => (props.run === undefined ? undefined : runResult(props.run)));
const elapsed = computed(() => (props.run === undefined ? undefined : runElapsed(props.run, props.now)));
/** The args and result in brief, for the overview. */
const about = computed(() => argSummary(props.run?.args, 200));
const brief = computed(() => resultBrief(result.value));
const detail = computed(() => (props.run === undefined ? '' : statusDetail(props.run, about.value)));

/** A value's fields as label and text, for the readable views. */
function readable(value: Json | undefined): { key: string; label: string; text: string }[] {
  if (value === undefined) { return []; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return [{ key: 'value', label: 'Value', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]; }
  return Object.entries(value).map(([key, v]) => ({ key, label: humanize(key), text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }));
}

const json = computed(() => JSON.stringify(props.record ?? props.run ?? null, null, 2));
</script>

<template>
  <div class="details" data-testid="run-details" :data-status="run?.status">
    <UiBanner v-if="problem !== ''" tone="danger">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <UiSkeleton v-if="loading && run === undefined" shape="lines" :lines="6" />
    <template v-else-if="run">
      <div class="status">
        <RunDot :status="run.status" :size="10" />
        <span class="word">{{ STATUS_LOOK[run.status].word }}</span>
        <span v-if="detail !== ''" class="text">{{ detail }}</span>
        <span v-if="run.background" class="dim">· in the background</span>
      </div>
      <dl class="facts">
        <template v-if="run.instance"><dt>Instance</dt><dd data-testid="run-instance">@{{ run.instance }}</dd></template>
        <template v-if="elapsed !== undefined"><dt>{{ isSettled(run.status) ? 'Took' : 'Running for' }}</dt><dd data-testid="run-elapsed">{{ formatDuration(elapsed) }}</dd></template>
        <template v-if="run.startedAt"><dt>Started</dt><dd>{{ fullTime(run.startedAt) }}</dd></template>
        <dt>Cost</dt><dd>{{ formatCost(run.cost) }}<span v-if="run.totalCost !== run.cost" class="dim"> · {{ formatCost(run.totalCost) }} with what it called</span></dd>
        <template v-if="run.attempt > 1"><dt>Attempt</dt><dd>{{ run.attempt }}</dd></template>
      </dl>
      <RunProgress v-if="run.progress && !isSettled(run.status)" :progress="run.progress" />
      <div class="ops">
        <UiButton v-if="run.allowed?.background && !run.background && !isSettled(run.status)" size="sm" icon="arrow-right" @click="emit('background')">Move to background</UiButton>
        <UiButton v-if="run.turn" size="sm" variant="ghost" icon="tree" @click="emit('tree')">Turn tree</UiButton>
        <UiButton v-if="run.llmCall" size="sm" variant="ghost" icon="sparkles" @click="run.llmCall && emit('llm', run.llmCall)">LLM call that asked</UiButton>
        <UiButton v-if="canSeeCalls" size="sm" variant="ghost" icon="cpu" data-testid="run-model-calls" @click="run && emit('calls', run.id)">Model calls</UiButton>
        <UiButton v-if="run.parent" size="sm" variant="ghost" icon="chevron-left" @click="run.parent && emit('run', run.parent)">Called by</UiButton>
        <UiButton v-if="run.turn && isSettled(run.status)" size="sm" variant="ghost" icon="undo" @click="emit('undo')">Undo the turn</UiButton>
      </div>
      <UiTabs v-model="tab" :tabs="tabs" label="Run details">
        <template #default="{ value }">
          <div v-if="value === 'overview'" class="pane">
            <section v-if="invalid" class="invalid" data-testid="run-invalid">
              <p class="invalid-title">{{ INPUT_PROBLEM_WORDS[invalid.source] }}. The agent was told why and can try again; this is not a failure.</p>
              <ul class="problems">
                <li v-for="(issue, i) in invalid.problems" :key="i"><code v-if="issue.path !== ''" class="path">{{ issue.path }}</code> {{ issue.message }}</li>
              </ul>
              <UiCodeBlock v-if="invalid.raw" :code="invalid.raw" language="text" :max-height="200" />
            </section>
            <p v-if="error" class="error" data-testid="run-error">{{ error.message }}<span v-if="error.code" class="dim"> ({{ error.code }})</span></p>
            <dl class="fields">
              <template v-if="about !== ''"><dt>Asked</dt><dd><code class="value">{{ about }}</code></dd></template>
              <dt>{{ isSettled(run.status) ? 'Returned' : 'So far' }}</dt>
              <dd>
                <pre v-if="brief !== ''" class="value brief" data-testid="run-brief">{{ brief }}</pre>
                <span v-else class="dim">{{ isSettled(run.status) ? 'Nothing.' : 'Still going.' }}</span>
              </dd>
            </dl>
          </div>
          <div v-else-if="value === 'args' && argsType !== undefined && run.args !== undefined" class="pane" data-testid="run-args-typed">
            <GinValueView :type="argsType" :model-value="run.args" readonly label="Args" />
          </div>
          <dl v-else-if="value === 'args' || value === 'result'" class="fields pane">
            <template v-for="field in readable(value === 'args' ? run.args : result)" :key="field.key">
              <dt>{{ field.label }}</dt>
              <dd><pre class="value">{{ field.text }}</pre></dd>
            </template>
            <p v-if="readable(value === 'args' ? run.args : result).length === 0" class="dim">{{ value === 'args' ? 'No args.' : 'No result yet.' }}</p>
          </dl>
          <ol v-else-if="value === 'errors'" class="errors pane" data-testid="run-errors">
            <li v-for="entry in run.errors" :key="entry.attempt">
              <strong>Attempt {{ entry.attempt }}</strong> · {{ entry.error.class }} · {{ fullTime(entry.at) }}
              <p class="error">{{ entry.error.message }}</p>
            </li>
          </ol>
          <UiCodeBlock v-else :code="json" language="json" :max-height="480" data-testid="run-json" />
        </template>
      </UiTabs>
    </template>
  </div>
</template>

<style scoped>
.details { display: grid; gap: var(--space-4); min-width: 0; }
.status { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.word { font-weight: var(--weight-strong); }
.text { color: var(--text-dim); }
.facts, .fields { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-faint); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dim { color: var(--text-faint); }
.ops { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr)); gap: var(--space-2); }
.ops :deep(.ui-button) { justify-content: flex-start; }
.brief { max-height: 240px; overflow: auto; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--code-bg); }
.pane { padding-top: var(--space-3); }
.value { margin: 0; font-family: var(--mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.error { margin: var(--space-1) 0 0; color: var(--danger); overflow-wrap: anywhere; }
.invalid { display: grid; gap: var(--space-2); margin-bottom: var(--space-3); padding: var(--space-3); border: 1px dashed var(--border-strong); border-radius: var(--radius); }
.invalid-title { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.problems { display: grid; gap: var(--space-1); margin: 0; padding-left: var(--space-4); font-size: var(--text-sm); }
.path { font-family: var(--mono); font-size: var(--text-xs); color: var(--text-dim); }
.errors { display: grid; gap: var(--space-3); margin: 0; padding-left: var(--space-4); font-size: var(--text-sm); }
</style>
