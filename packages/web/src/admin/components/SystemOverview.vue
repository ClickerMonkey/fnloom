<script setup lang="ts">
/**
 * A system’s overview: switching its functions, renderers and context on and off (separately, so old messages keep drawing),
 * the facts about it, its process when the hub runs it (start, stop, restart, upgrade, and how it last exited), who
 * hosts it when another system runs it ("hosted by fs/main at systems/random", with start, restart and stop through
 * that host), and reimporting or removing it. Its facts are its default instance's (`InstanceFacts`, as on an
 * instance's page), so a system that runs one instance shows that instance here.
 */
import AccessControl from '../../components/access/AccessControl.vue';
import type { SystemEnabled, SystemView } from '@harness/core';
import { computed, ref } from 'vue';
import { copyText, UiBadge, UiButton, UiCard, UiCodeBlock, UiIconButton, UiInput, UiSwitch, fullTime, relativeTime, shortHash } from '../../ui/index.ts';
import { hostText, INSTALLED_STATUS_LOOK, systemActions, type SystemAction } from '../logic/systems.ts';
import InstanceFacts from './InstanceFacts.vue';
import StatusBadge from './StatusBadge.vue';

const props = withDefaults(defineProps<{
  system: SystemView;
  now: number;
  /** The action running now. */
  acting?: SystemAction | undefined;
  nameOf: (actor: SystemView['actor']) => string;
}>(), { acting: undefined });
const emit = defineEmits<{ enable: [part: keyof SystemEnabled, on: boolean]; act: [action: SystemAction, version?: string] }>();

const actions = computed(() => systemActions(props.system));
const version = ref('');
const installed = computed(() => props.system.installed);
const source = computed(() => {
  const from = installed.value?.source;
  if (from === undefined) { return ''; }
  if ('package' in from) { return `${from.package}@${from.version}`; }
  if ('git' in from) { return `${from.git}#${from.ref}`; }
  if ('zip' in from) { return `${from.file} (uploaded package)`; }
  return from.path;
});

/** Copy the hosted bundle's whole hash (the card shows it shortened). */
function copyBundle(): void {
  const hash = props.system.host?.bundleHash;
  if (hash !== undefined) { void copyText(hash); }
}

const busy = (action: SystemAction): boolean => props.acting === action;
const blocked = computed(() => props.acting !== undefined);
</script>

<template>
  <div class="overview">
    <div class="col">
      <UiCard title="Switches" subtitle="Turning functions off keeps renderers drawing old messages.">
        <div class="switches">
          <UiSwitch
            :model-value="system.enabled.functions" label="Functions" description="Its fns, mentions and hooks can be used."
            data-testid="enable-functions" @update:model-value="emit('enable', 'functions', $event)"
          />
          <UiSwitch
            :model-value="system.enabled.renderers" label="Renderers" description="Its own views draw in the chat; off uses plain views."
            data-testid="enable-renderers" @update:model-value="emit('enable', 'renderers', $event)"
          />
          <UiSwitch
            :model-value="system.enabled.context ?? true" label="Context" description="Its context items can be selected, searched and loaded; each keeps its own switch."
            data-testid="enable-context" @update:model-value="emit('enable', 'context', $event)"
          />
        </div>
      </UiCard>

      <AccessControl :target="{ kind: 'system', system: system.name }" />
      <UiCard v-if="system.host" title="Hosted" :subtitle="`By ${hostText(system.host)}`" data-testid="system-host">
        <div class="process">
          <dl class="facts">
            <div>
              <dt>Bundle</dt>
              <dd class="hash">
                <code :title="system.host.bundleHash">{{ shortHash(system.host.bundleHash) }}</code>
                <UiIconButton icon="copy" size="sm" label="Copy the bundle hash" data-testid="host-copy-bundle" @click="copyBundle" />
              </dd>
            </div>
          </dl>
          <div class="buttons">
            <UiButton v-if="actions.has('start')" variant="primary" icon="play" :loading="busy('start')" :disabled="blocked" data-testid="host-start" @click="emit('act', 'start')">Start</UiButton>
            <UiButton v-if="actions.has('restart')" icon="refresh" :loading="busy('restart')" :disabled="blocked" data-testid="host-restart" @click="emit('act', 'restart')">Restart</UiButton>
            <UiButton v-if="actions.has('stop')" icon="stop" :loading="busy('stop')" :disabled="blocked" data-testid="host-stop" @click="emit('act', 'stop')">Stop</UiButton>
          </div>
        </div>
      </UiCard>
      <UiCard v-if="installed" title="Process" :subtitle="source">
        <template #actions><StatusBadge :look="INSTALLED_STATUS_LOOK[installed.status]" /></template>
        <div class="process">
          <dl class="facts">
            <div><dt>Running</dt><dd>{{ installed.version }}<span v-if="installed.goodVersion && installed.goodVersion !== installed.version" class="dim"> (last good {{ installed.goodVersion }})</span></dd></div>
            <div v-if="installed.pid !== undefined"><dt>Process</dt><dd>{{ installed.pid }}</dd></div>
            <div><dt>Starts with hub</dt><dd>{{ installed.autoStart ? 'Yes' : 'No' }}</dd></div>
            <div><dt>Restarts</dt><dd>{{ installed.restart.policy === 'never' ? 'Never' : `${installed.restart.policy === 'always' ? 'Always' : 'On failure'}, at most ${installed.restart.maxPerHour} an hour` }}</dd></div>
          </dl>
          <div class="buttons">
            <UiButton v-if="actions.has('start')" variant="primary" icon="play" :loading="busy('start')" :disabled="blocked" data-testid="act-start" @click="emit('act', 'start')">Start</UiButton>
            <UiButton v-if="actions.has('stop')" icon="stop" :loading="busy('stop')" :disabled="blocked" data-testid="act-stop" @click="emit('act', 'stop')">Stop</UiButton>
            <UiButton v-if="actions.has('restart')" icon="refresh" :loading="busy('restart')" :disabled="blocked" data-testid="act-restart" @click="emit('act', 'restart')">Restart</UiButton>
          </div>
          <form v-if="actions.has('upgrade')" class="upgrade" @submit.prevent="emit('act', 'upgrade', version.trim())">
            <UiInput v-model="version" label="Upgrade to" placeholder="Latest version" />
            <UiButton type="submit" icon="arrow-up" :loading="busy('upgrade')" :disabled="blocked" data-testid="act-upgrade">Upgrade</UiButton>
          </form>
          <div v-if="installed.lastExit" class="exit">
            <p class="exit-title">
              Last exit <UiBadge :tone="installed.lastExit.code === 0 ? 'neutral' : 'danger'">code {{ installed.lastExit.code }}</UiBadge>
              <time class="dim" :title="fullTime(installed.lastExit.at)">{{ relativeTime(installed.lastExit.at, now) }}</time>
            </p>
            <UiCodeBlock v-if="installed.lastExit.output !== ''" :code="installed.lastExit.output" language="text" :max-height="220" />
          </div>
        </div>
      </UiCard>

      <UiCard title="Maintenance">
        <div class="maintenance">
          <div v-if="actions.has('reimport')" class="row">
            <div><p class="row-title">Reimport</p><p class="dim">Read its contract again and report what changed.</p></div>
            <UiButton icon="refresh" :loading="busy('reimport')" :disabled="blocked" data-testid="act-reimport" @click="emit('act', 'reimport')">Reimport</UiButton>
          </div>
          <div v-if="actions.has('remove')" class="row">
            <div><p class="row-title">Remove</p><p class="dim">Its fns stop working until it pairs again.</p></div>
            <UiButton variant="danger" icon="trash" :disabled="blocked" data-testid="act-remove" @click="emit('act', 'remove')">Remove</UiButton>
          </div>
        </div>
      </UiCard>
    </div>
    <div class="col">
      <UiCard title="Details">
        <!-- a hosted system's card already says where it runs -->
        <InstanceFacts :source="system" :now="now" :name-of="nameOf" :hosted="system.host !== undefined" testid="system-facts" />
      </UiCard>
    </div>
  </div>
</template>

<style scoped>
/* two columns that stack their cards, so a tall card on one side leaves no hole on the other */
.overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; gap: var(--space-4); }
.col { display: grid; align-content: start; gap: var(--space-4); min-width: 0; }
.switches, .process, .maintenance { display: grid; gap: var(--space-4); }
.facts { display: grid; gap: var(--space-3); margin: 0; }
.facts > div { display: grid; grid-template-columns: minmax(96px, 30%) minmax(0, 1fr); gap: var(--space-3); }
dt { color: var(--text-dim); font-size: var(--text-sm); }
dd { margin: 0; overflow-wrap: anywhere; font-size: var(--text-sm); }
.hash { display: flex; align-items: center; gap: var(--space-1); }
.buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.buttons:empty { display: none; }
.upgrade { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-2); }
.upgrade > :first-child { flex: 1 1 180px; }
.exit { display: grid; gap: var(--space-2); }
.exit-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; font-weight: var(--weight-medium); }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
.row-title { margin: 0; font-weight: var(--weight-medium); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
