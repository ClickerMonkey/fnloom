<script setup lang="ts">
/**
 * The Ollama page (`/s/ollama/servers`, admins): every instance of the system, one at a time (`?on=` in the URL). For
 * the one shown: its server's state, address, version and last output (`ollama/status`, read quietly as the admin on
 * that instance), its installed models (`ollama/models`) with an Offer switch each (the instance's config `offered`,
 * written back with the hub's `configureSystem`), and the server's actions, Install, Start, Stop, Pull and Remove,
 * each the admin's own run in an "Ollama" chat whose approval is answered here. A pull's progress is read again every
 * second while it runs.
 */
import { jsonOf, SystemName, type Json, type QualifiedName, type Remember } from '@harness/core';
import type { PageRuns, PageViewOf, SelectChoice } from '@harness/sdk';
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { OLLAMA_FNS, OLLAMA_SYSTEM, type InstalledModel, type OllamaContract, type OllamaStatus } from '../shared/index.ts';
import { abilities, actionsOf, bytes, checkedOf, instancesOf, offerFor, problemText, readModels, readStatus, stateOf, valueOf, withOffer, type PageInstance } from './logic.ts';

/** How often the page reads the server again (ms); every second while a pull runs. */
const REFRESH = 5_000;
const PULLING = 1_000;

const view = defineProps<PageViewOf<OllamaContract>>();
const host = view.host;
const { Frame, Select, Button, Input, LoadState, Empty, Badge, Banner, Approval } = host.components;

const systems = host.hub.caller('systems');
const readFn = host.hub.caller('readFn');
const configure = host.hub.caller('configureSystem');

const instances = shallowRef<PageInstance[]>([]);
const loading = ref(true);
const problem = ref('');
const on = host.query.bind('on');
const current = computed((): PageInstance | undefined => instances.value.find((i) => i.instance === on.value) ?? instances.value[0]);
const choices = computed((): SelectChoice[] => instances.value.map((i) => ({ value: i.instance, label: i.connected ? i.instance : `${i.instance} (offline)` })));

const status = shallowRef<OllamaStatus | undefined>(undefined);
const models = shallowRef<InstalledModel[]>([]);
const modelsProblem = ref('');
const busy = ref('');
const pullName = ref('');

/** The admin's runs, in one "Ollama" chat; its approvals are answered on this page. */
let runs: PageRuns | undefined;
const runsOf = (): PageRuns => { runs ??= host.runs({ title: () => 'Ollama' }); return runs; };
const approvals = computed(() => (busy.value === '' ? [] : runs?.approvals ?? []));
onBeforeUnmount(() => { runs?.close(); });

async function loadInstances(): Promise<void> {
  try {
    const all = await systems.call({});
    instances.value = instancesOf(all.find((s) => s.name === OLLAMA_SYSTEM));
    problem.value = '';
  } catch (error) {
    problem.value = problemText(error, 'The Ollama instances could not be read.');
  } finally {
    loading.value = false;
  }
}

/** Read the shown instance's status and models, quietly as the admin, on that instance. */
async function loadServer(): Promise<void> {
  const target = current.value;
  if (target === undefined || !target.connected || target.config === undefined) { status.value = undefined; models.value = []; return; }
  const on = target.instance;
  try {
    status.value = readStatus(await readFn.call({ fn: OLLAMA_FNS.status, args: {}, on }));
  } catch (error) {
    status.value = undefined;
    modelsProblem.value = problemText(error, 'The server could not be read.');
    return;
  }
  if (!status.value.answering) { models.value = []; modelsProblem.value = ''; return; }
  try {
    models.value = readModels(await readFn.call({ fn: OLLAMA_FNS.models, args: {}, on }));
    modelsProblem.value = '';
  } catch (error) {
    modelsProblem.value = problemText(error, 'The models could not be read.');
  }
}

watch(() => current.value?.instance, () => { void loadServer(); });
void loadInstances().then(loadServer);
host.live(() => { void loadInstances().then(loadServer); }, REFRESH);
let pullTimer: ReturnType<typeof setInterval> | undefined;
watch(() => (status.value?.pulls.length ?? 0) > 0, (pulling) => {
  clearInterval(pullTimer);
  pullTimer = pulling ? setInterval(() => { void loadServer(); }, PULLING) : undefined;
});
onBeforeUnmount(() => { clearInterval(pullTimer); });

const state = computed(() => (status.value === undefined ? undefined : stateOf(status.value.state, status.value.answering)));
const can = computed(() => actionsOf(status.value));

/** Run one of the system's fns on the shown instance as the admin; its approval waits on this page. */
async function act(fn: QualifiedName, args: Json, label: string): Promise<void> {
  const target = current.value;
  if (target === undefined || busy.value !== '') { return; }
  busy.value = label;
  try {
    const outcome = await runsOf().run(fn, args, { on: target.instance, waiting: () => { void loadServer(); } });
    if (outcome.ok) { host.notify.ok(`${label}: done`); } else { host.notify.error(`${label} didn't finish`, outcome.problem); }
  } finally {
    busy.value = '';
    await loadServer();
  }
}

async function decide(approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<void> {
  const approval = approvals.value[0];
  if (runs === undefined || approval === undefined) { return; }
  if (!(await runs.approve(approval, approve, remember, reason, answer))) { host.notify.error("Couldn't send your answer", runs.problem); }
}

function pull(): void {
  const model = pullName.value.trim();
  if (model === '') { return; }
  pullName.value = '';
  void act(OLLAMA_FNS.pull, { model }, `Pull ${model}`);
}

/** Offer a model to the chat, or stop offering it: the instance's config, written back. */
async function setOffered(model: string, offered: boolean): Promise<void> {
  const target = current.value;
  if (target?.config === undefined) { return; }
  const next = withOffer(target.config, model, offered ? { decision: offerFor(target.config, model)?.decision ?? false } : undefined);
  const result = await configure.call({ system: SystemName.parse(OLLAMA_SYSTEM), instance: target.instance, config: jsonOf(next) }).catch((error: unknown) => ({ problems: [problemText(error, 'The config could not be saved.')] }));
  if ('problems' in result) { host.notify.error("Couldn't change the offer", result.problems.join('; ')); return; }
  host.notify.ok(offered ? `${model} is offered to the chat` : `${model} is no longer offered`);
  await loadInstances();
  await loadServer();
}

/** An offered model's context cap, saved when the field is left. */
async function setWindow(model: string, text: string): Promise<void> {
  const target = current.value;
  const offer = offerFor(target?.config, model);
  if (target?.config === undefined || offer === undefined) { return; }
  const value = Number(text);
  const { contextWindow: _old, ...rest } = offer;
  const next = withOffer(target.config, model, text.trim() === '' || !Number.isInteger(value) || value < 256 ? rest : { ...rest, contextWindow: value });
  const result = await configure.call({ system: SystemName.parse(OLLAMA_SYSTEM), instance: target.instance, config: jsonOf(next) }).catch((error: unknown) => ({ problems: [problemText(error, 'The config could not be saved.')] }));
  if ('problems' in result) { host.notify.error("Couldn't change the limit", result.problems.join('; ')); return; }
  await loadInstances();
}
</script>

<template>
  <Frame title="Ollama" description="Every Ollama server: its status, installed models, which are offered to the chat, and pulls." width="wide" keep-title>
    <template #actions>
      <Select v-if="choices.length > 1" v-model="on.value" :options="choices" label="Instance" hide-label data-testid="ollama-instance" />
    </template>

    <LoadState :loading="loading" :problem="problem" :ready="instances.length > 0" :empty="!loading && instances.length === 0" @retry="loadInstances">
      <template #empty>
        <Empty icon="server" title="No Ollama instances" body="Pair the ollama system on a machine; each machine or server is one instance." />
      </template>

      <section v-if="current" class="server" data-testid="ollama-server">
        <header class="head">
          <h2>{{ current.instance }}</h2>
          <Badge v-if="!current.connected" tone="neutral">Offline</Badge>
          <Badge v-else-if="state" :tone="state.tone" dot>{{ state.label }}</Badge>
        </header>

        <Banner v-if="current.connected && current.config === undefined" tone="warn" icon="alert">This instance needs its config first: where Ollama runs (managed, an existing program, or a URL).</Banner>
        <Banner v-if="status?.problem" tone="warn" icon="alert" data-testid="ollama-problem">{{ status.problem }}</Banner>

        <dl v-if="status" class="facts">
          <div><dt>Mode</dt><dd>{{ status.mode === 'managed' ? 'Installed here' : status.mode === 'binary' ? 'Existing program' : 'Runs on its own' }}</dd></div>
          <div><dt>Address</dt><dd><code>{{ status.url }}</code></dd></div>
          <div v-if="status.version"><dt>Version</dt><dd>{{ status.version }}</dd></div>
          <div v-if="status.installed"><dt>Installed</dt><dd>{{ status.installed.version }} ({{ status.installed.asset }}{{ status.installed.sha256 ? ', sha-256 checked' : '' }})</dd></div>
          <div v-if="status.modelsDir"><dt>Models folder</dt><dd><code>{{ status.modelsDir }}</code></dd></div>
          <div v-if="status.restartsLastHour > 0"><dt>Restarts this hour</dt><dd>{{ status.restartsLastHour }}</dd></div>
        </dl>

        <div v-if="status" class="buttons">
          <Button v-if="can.install" variant="secondary" icon="download" :loading="busy === 'Install Ollama'" :disabled="busy !== ''" data-testid="ollama-install" @click="act(OLLAMA_FNS.install, {}, 'Install Ollama')">{{ status.installed ? 'Install the latest' : 'Install Ollama' }}</Button>
          <Button v-if="can.start" variant="primary" icon="play" :loading="busy === 'Start Ollama'" :disabled="busy !== ''" data-testid="ollama-start" @click="act(OLLAMA_FNS.start, {}, 'Start Ollama')">Start</Button>
          <Button v-if="can.stop" variant="secondary" icon="stop" :loading="busy === 'Stop Ollama'" :disabled="busy !== ''" data-testid="ollama-stop" @click="act(OLLAMA_FNS.stop, {}, 'Stop Ollama')">Stop</Button>
        </div>

        <Approval v-for="approval in approvals" :key="approval.id" :approval="approval" in-chat description="This changes the Ollama server on this machine." @decide="decide" />

        <div v-for="item in status?.pulls ?? []" :key="item.model" class="pull" data-testid="ollama-pull-progress">
          <span>{{ item.model }}: {{ item.status }}</span>
          <progress :value="item.fraction" max="1" />
          <span v-if="item.total > 0" class="dim">{{ bytes(item.completed) }} of {{ bytes(item.total) }}</span>
        </div>

        <h3>Models</h3>
        <form v-if="status?.answering" class="pull-form" @submit.prevent="pull">
          <Input v-model="pullName" label="Pull a model" hide-label placeholder="Model to pull, such as qwen3:8b" :disabled="busy !== ''" />
          <Button type="submit" variant="secondary" icon="download" :disabled="busy !== '' || pullName.trim() === ''" data-testid="ollama-pull">Pull</Button>
        </form>
        <p v-if="modelsProblem" class="dim">{{ modelsProblem }}</p>
        <p v-else-if="status && !status.answering" class="dim">The server isn't answering, so its models can't be listed.</p>
        <table v-else-if="models.length > 0" class="models" data-testid="ollama-models">
          <thead><tr><th>Model</th><th>Size</th><th>Details</th><th>Offered</th><th>Context cap</th><th /></tr></thead>
          <tbody>
            <tr v-for="model in models" :key="model.name">
              <td><strong>{{ model.name }}</strong></td>
              <td>{{ bytes(model.size) }}</td>
              <td class="dim">{{ [model.family, model.parameters, model.quantization].filter(Boolean).join(' · ') }}<br>{{ abilities(model) }}</td>
              <td><input type="checkbox" :checked="model.offered" :aria-label="`Offer ${model.name} to the chat`" :disabled="busy !== ''" @change="setOffered(model.name, checkedOf($event))"></td>
              <td>
                <input v-if="model.offered" class="cap" type="number" min="256" :value="offerFor(current.config, model.name)?.contextWindow ?? ''" :placeholder="String(model.servedWindow)" :aria-label="`Most context for ${model.name}`" @change="setWindow(model.name, valueOf($event))">
              </td>
              <td><Button variant="ghost" size="sm" icon="trash" :disabled="busy !== ''" @click="act(OLLAMA_FNS.remove, { model: model.name }, `Remove ${model.name}`)">Remove</Button></td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="status?.answering" class="dim">No models yet: pull one above.</p>

        <details v-if="status && status.output.length > 0" class="output">
          <summary>Server output</summary>
          <pre>{{ status.output.slice(-40).join('\n') }}</pre>
        </details>
      </section>
    </LoadState>
  </Frame>
</template>

<style scoped>
.server { display: grid; gap: var(--space-3); min-width: 0; }
.head { display: flex; align-items: center; gap: var(--space-2); }
.head h2 { margin: 0; font-size: var(--text-lg, 1.125rem); }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); gap: var(--space-2); margin: 0; }
.facts dt { color: var(--text-dim); font-size: var(--text-sm); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pull { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 2fr) auto; gap: var(--space-2); align-items: center; }
.pull progress { width: 100%; }
.pull-form { display: flex; gap: var(--space-2); max-width: 32rem; }
.pull-form > :first-child { flex: 1; }
.models { width: 100%; border-collapse: collapse; }
.models th, .models td { text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--border); vertical-align: top; }
.cap { width: 7rem; }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
.output pre { white-space: pre-wrap; max-height: 20rem; overflow: auto; font-size: var(--text-sm); }
h3 { margin: var(--space-3) 0 0; font-size: var(--text-md, 1rem); }
@media (max-width: 759.98px) { .models th:nth-child(3), .models td:nth-child(3) { display: none; } }
</style>
