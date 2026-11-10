<script setup lang="ts">
/**
 * The page a system's pairing QR code opens (`/pair/:pairing?code=`), phone first. It shows the system that asked
 * (name, what it said about itself, version, address, key fingerprint, when the request expires) and whether the code
 * in the link is the one the system shows; the admin names the instance, fills in its config (the gin value editor,
 * from the config type the system sent) and pairs it in one step, or refuses. It then follows the system live until
 * it is connected and links to its admin page. Signing in comes first and returns here.
 */
import { InstanceName, PairingId, type AutoPairChoice, type Json } from '@harness/core';
import { computed, onBeforeUnmount, provide, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import GinValueView from '../gin/GinValueView.vue';
import { GIN_SECRETS } from '../gin/types.ts';
import AutoPairPicker from '../admin/components/AutoPairPicker.vue';
import LoadState from '../admin/components/LoadState.vue';
import { useStores } from '../state/stores.ts';
import { UiBadge, UiBanner, UiButton, UiCard, UiEmpty, UiIcon, UiInput, UiSpinner, fullTime } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { admin, toasts } = useStores();
const store = admin.pairing;
const route = useRoute();
const router = useRouter();
const now = useNow(1_000);
const query = useRouteQuery(ROUTES.pair);
const code = query.text('code');
const id = computed(() => { const parsed = PairingId.safeParse(route.params['pairing']); return parsed.success ? parsed.data : undefined; });
const request = computed(() => store.request.value.value);
// the config's secret fields (the system named them while waiting) are password inputs, as on the config page
const secretPaths = reactive(new Set<string>());
provide(GIN_SECRETS, secretPaths);
watch(() => request.value?.configSecrets, (paths) => {
  secretPaths.clear();
  for (const path of paths ?? []) { secretPaths.add(path); }
}, { immediate: true });
const phase = computed(() => store.phase.value);
const instance = ref('');
const config = shallowRef<Json | undefined>(undefined);
const configValid = ref(true);
const autoPair = ref<AutoPairChoice | undefined>(undefined);

watch(id, (pairing) => { if (pairing !== undefined) { void store.open(pairing); } }, { immediate: true });
watch(request, (r) => {
  if (r === undefined) { return; }
  if (instance.value === '') { instance.value = r.instance ?? 'main'; }
}, { immediate: true });
onBeforeUnmount(() => { store.close(); });

const matches = computed(() => code.value === '' || store.codeMatches(code.value));
const instanceName = computed(() => InstanceName.safeParse(instance.value.trim()));
const instanceProblem = computed(() => (instance.value.trim() === '' || instanceName.value.success ? '' : 'Lowercase letters, digits and dashes, starting with a letter.'));
const canPair = computed(() => phase.value === 'waiting' && matches.value && instanceProblem.value === '' && (request.value?.configType === undefined || (configValid.value && config.value !== undefined)));
const left = computed(() => (request.value === undefined ? 0 : Math.max(0, request.value.expiresAt - now.value)));
const leftText = computed(() => { const s = Math.floor(left.value / 1_000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; });

async function pair(): Promise<void> {
  const name = instanceName.value.success ? instanceName.value.data : undefined;
  const result = await store.approve(name, request.value?.configType === undefined ? undefined : config.value, autoPair.value);
  if (!result.ok) { toasts.error(result.problem); }
}

async function refuse(): Promise<void> {
  if (await store.refuse()) { toasts.ok('Refused', 'The system was told no.'); }
}
</script>

<template>
  <AppPage title="Pair a system" description="A system you started asked to join this hub." width="readable">
    <LoadState :loading="store.request.loading.value" :problem="store.request.problem.value" :ready="request !== undefined" :empty="false" :lines="8" @retry="id && store.open(id)">
      <template v-if="request">
        <UiCard>
          <div class="who" data-testid="pair-system">
            <span class="mark" aria-hidden="true"><UiIcon name="server" :size="22" /></span>
            <div class="main">
              <p class="name">{{ request.name }}<span class="dim"> v{{ request.version }}</span></p>
              <p v-if="request.description" class="dim">{{ request.description }}</p>
            </div>
          </div>
          <dl class="facts">
            <div><dt>Address</dt><dd>{{ request.address }}</dd></div>
            <div><dt>Key</dt><dd><code>{{ request.keyFingerprint }}</code></dd></div>
            <div v-if="request.code">
              <dt>Code</dt>
              <dd class="code-row">
                <strong class="code" data-testid="pair-code">{{ request.code }}</strong>
                <UiBadge v-if="code !== ''" :tone="matches ? 'ok' : 'danger'" data-testid="pair-code-check">{{ matches ? 'Matches the link' : 'Not the code in the link' }}</UiBadge>
              </dd>
            </div>
            <div><dt>Expires</dt><dd :title="fullTime(request.expiresAt)">{{ left > 0 ? `in ${leftText}` : 'expired' }}</dd></div>
            <div v-if="request.replaces"><dt>Replaces</dt><dd>the key of {{ request.replaces }}</dd></div>
          </dl>
        </UiCard>

        <UiBanner v-if="!matches" tone="danger">The code in this link isn’t the one the system shows. Open the link the system printed, or pair it from the systems page.</UiBanner>

        <template v-if="phase === 'waiting' || phase === 'pairing'">
          <UiCard title="Instance" subtitle="Its name here, so a fleet's copies can be told apart (fs@laptop).">
            <div class="instance">
              <UiInput v-model="instance" label="Instance" hide-label :error="instanceProblem" data-testid="pair-instance" />
              <AutoPairPicker v-model="autoPair" />
            </div>
          </UiCard>
          <UiCard v-if="request.configType" title="Config" subtitle="Checked against the system’s config type; it starts with this.">
            <GinValueView v-model="config" :type="request.configType" label="Config" data-testid="pair-config" @problems="configValid = $event.length === 0" />
          </UiCard>
          <div class="actions">
            <UiButton variant="ghost" :disabled="phase === 'pairing'" data-testid="pair-refuse" @click="refuse">Refuse</UiButton>
            <UiButton variant="primary" icon="check" :loading="phase === 'pairing'" :disabled="!canPair" data-testid="pair-approve" @click="pair">Pair {{ request.name }}</UiButton>
          </div>
        </template>

        <UiCard v-else-if="phase === 'joining' || phase === 'connected' || phase === 'needs-config'" data-testid="pair-done" :data-phase="phase">
          <div class="done">
            <UiSpinner v-if="phase === 'joining'" :size="20" />
            <UiIcon v-else :name="phase === 'connected' ? 'success' : 'warning'" :size="22" />
            <div>
              <p class="name">{{ phase === 'connected' ? `${store.system.value} is connected` : phase === 'needs-config' ? `${store.system.value} needs its config` : `Waiting for ${store.system.value} to connect…` }}</p>
              <p class="dim">{{ phase === 'connected' ? 'Its fns are ready to use.' : phase === 'needs-config' ? 'It paired, but its config wasn’t accepted. Set it on its page.' : 'It was paired; it connects in a moment.' }}</p>
            </div>
          </div>
          <div class="actions">
            <UiButton v-if="store.system.value" variant="primary" icon="arrow-right" data-testid="pair-open-system" @click="store.system.value && router.push(links.system(store.system.value))">Open its page</UiButton>
          </div>
        </UiCard>

        <UiEmpty v-else-if="phase === 'refused'" icon="x" title="Refused" body="The system was told no. It can ask again." />
        <UiEmpty v-else-if="phase === 'expired'" icon="clock" title="This request expired" body="Restart the system to get a new code.">
          <template #actions><UiButton @click="router.push(links.systems())">Systems</UiButton></template>
        </UiEmpty>
        <UiEmpty v-else-if="phase === 'elsewhere'" icon="check" title="Already answered" :body="`This request was ${request.status}.`">
          <template #actions><UiButton @click="router.push(links.system(request.name))">Open {{ request.name }}</UiButton></template>
        </UiEmpty>
      </template>
    </LoadState>
  </AppPage>
</template>

<style scoped>
.instance { display: grid; gap: var(--space-3); }
.who { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); }
.mark { display: grid; place-items: center; width: 44px; height: 44px; flex: none; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent); }
.main { min-width: 0; }
.name { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); font-weight: var(--weight-normal, 400); }
.facts { display: grid; gap: var(--space-3); margin: 0; }
.facts > div { display: grid; grid-template-columns: minmax(80px, 30%) minmax(0, 1fr); gap: var(--space-3); }
dt { color: var(--text-dim); font-size: var(--text-sm); }
dd { margin: 0; overflow-wrap: anywhere; font-size: var(--text-sm); }
.code-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.code { font-family: var(--mono); font-size: var(--text-lg); letter-spacing: 0.12em; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.done { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
@media (max-width: 559.98px) {
  .actions > * { flex: 1 1 100%; }
}
</style>
