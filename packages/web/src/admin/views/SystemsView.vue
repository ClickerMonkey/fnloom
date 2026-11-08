<script setup lang="ts">
/**
 * The systems page: pairing requests waiting for an answer at the top (a notification's `?pairing=` lights one up),
 * then every system, those needing the admin first. Pairing tokens and installing a system open as dialogs.
 */
import type { InstallSource, PairingRequest, SystemName } from '@harness/core';
import { computed, onMounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { ROUTES, links } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiEmpty } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import InstallDialog from '../components/InstallDialog.vue';
import LoadState from '../components/LoadState.vue';
import PairingCard from '../components/PairingCard.vue';
import SystemCard from '../components/SystemCard.vue';
import TokenDialog from '../components/TokenDialog.vue';
import { pendingPairings } from '../logic/systems.ts';
import type { PairingToken } from '../state/systems.ts';

const { admin, toasts } = useStores();
const systems = admin.systems;
const router = useRouter();
const now = useNow(1_000);
const query = useRouteQuery(ROUTES.systems);
const highlight = query.text('pairing');
const pending = computed(() => pendingPairings(systems.pairings.value.value ?? [], now.value));
const tokenOpen = ref(false);
const installOpen = ref(false);
const token = shallowRef<PairingToken | undefined>(undefined);

onMounted(() => { void systems.load(systems.list.value.value !== undefined); });

async function answer(pairing: PairingRequest, approve: boolean): Promise<void> {
  const result = await systems.answerPairing(pairing.id, approve);
  if (!result.ok) { toasts.error(result.problem); return; }
  toasts.ok(approve ? `${pairing.name} is paired` : `Rejected ${pairing.name}`);
  if (highlight.value === pairing.id) { highlight.value = ''; }
}

function openToken(): void {
  token.value = undefined;
  tokenOpen.value = true;
}

async function createToken(name: SystemName | undefined, expiresIn: number): Promise<void> {
  const result = await systems.createToken(name, expiresIn);
  if (result.ok) { token.value = result.value; }
}

async function install(source: InstallSource, autoStart: boolean): Promise<void> {
  const result = await systems.installSystem(source, autoStart);
  if (!result.ok) { return; }
  installOpen.value = false;
  toasts.ok(`Installing ${result.value.name}`);
  await router.push(links.system(result.value.name));
}
</script>

<template>
  <AppPage title="Systems" description="What your hub is connected to, and what each one adds.">
    <template #actions>
      <UiButton icon="key" data-testid="open-token" @click="openToken">Pairing token</UiButton>
      <UiButton variant="primary" icon="plus" data-testid="open-install" @click="installOpen = true">Install</UiButton>
    </template>

    <section v-if="pending.length > 0" class="pairings" aria-labelledby="pairings-title">
      <h2 id="pairings-title" class="section-title">Waiting to pair <span class="count">{{ pending.length }}</span></h2>
      <div class="pairing-grid">
        <PairingCard
          v-for="pairing in pending" :key="pairing.id" :pairing="pairing" :now="now" :busy="systems.answering.value.has(pairing.id)"
          :highlight="highlight === pairing.id" @approve="answer(pairing, true)" @reject="answer(pairing, false)"
        />
      </div>
    </section>

    <LoadState
      :loading="systems.list.loading.value" :problem="systems.list.problem.value" :ready="systems.list.value.value !== undefined"
      :empty="systems.sorted.value.length === 0" :lines="6" @retry="systems.load()"
    >
      <template #empty>
        <UiEmpty icon="server" title="No systems yet" body="Start a system and approve its pairing here, or install one for the hub to run.">
          <template #actions><UiButton variant="primary" icon="plus" @click="installOpen = true">Install a system</UiButton></template>
        </UiEmpty>
      </template>
      <ul class="systems" data-testid="systems">
        <li v-for="system in systems.sorted.value" :key="system.name">
          <SystemCard :system="system" :now="now" :to="links.system(system.name)" />
        </li>
      </ul>
    </LoadState>

    <TokenDialog v-model:open="tokenOpen" :busy="systems.token.busy.value" :problem="systems.token.problem.value" :token="token" :now="now" @create="createToken" />
    <InstallDialog v-model:open="installOpen" :busy="systems.install.busy.value" :problem="systems.install.problem.value" @install="install" />
  </AppPage>
</template>

<style scoped>
.pairings { display: grid; gap: var(--space-3); }
.section-title { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.count { min-width: 20px; padding: 0 6px; border-radius: var(--radius-full); background: var(--accent); color: var(--on-accent); font-size: 11px; line-height: 20px; text-align: center; }
.pairing-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: var(--space-3); }
.systems { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
</style>
