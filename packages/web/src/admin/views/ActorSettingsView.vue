<script setup lang="ts">
/** Actor settings: the typed controls each system declares, the values set on actors, and setting them. */
import type { ActorId, Json } from '@harness/core';
import { computed, onMounted, ref, shallowRef } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { useStores } from '../../state/stores.ts';
import { useNow } from '../../ui/now.ts';
import LoadState from '../components/LoadState.vue';
import SettingCard from '../components/SettingCard.vue';
import SettingDialog from '../components/SettingDialog.vue';
import type { SettingEntry } from '../state/settings.ts';

const { admin, session, toasts } = useStores();
const settings = admin.settings;
const actors = admin.actors;
const now = useNow();
const open = ref(false);
const entry = shallowRef<SettingEntry | undefined>(undefined);
const actor = ref<ActorId | undefined>(undefined);
const choices = computed(() => actors.options(entry.value?.view.decl.appliesTo ?? []));

onMounted(() => { void settings.load(settings.data.value.value !== undefined); void actors.load(); });

function edit(target: SettingEntry, who: ActorId | undefined): void {
  entry.value = target;
  actor.value = who;
  open.value = true;
}

async function save(who: ActorId, value: Json): Promise<void> {
  const target = entry.value;
  const me = session.user.value?.id;
  if (target === undefined || me === undefined) { return; }
  if (await settings.set(target.view.setting, who, value, me, Date.now())) {
    open.value = false;
    toasts.ok(`Saved for ${actors.nameOf(who)}`);
  }
}
</script>

<template>
  <AppPage title="Actor settings" description="Typed controls systems attach to people and groups, such as which rows a group may read.">
    <LoadState
      :loading="settings.data.loading.value" :problem="settings.data.problem.value" :ready="settings.data.value.value !== undefined"
      :empty="settings.groups.value.length === 0" empty-icon="users" empty-title="No actor settings" empty-body="Systems that declare settings list them here." @retry="settings.load()"
    >
      <section v-for="group in settings.groups.value" :key="group.system" class="group" :aria-labelledby="`settings-${group.system}`">
        <h2 :id="`settings-${group.system}`" class="system">{{ group.system }}</h2>
        <div class="cards">
          <SettingCard v-for="item in group.settings" :key="item.view.setting" :entry="item" :name-of="actors.nameOf" :now="now" @edit="edit(item, $event)" />
        </div>
      </section>
    </LoadState>
    <SettingDialog v-model:open="open" :entry="entry" :actors="choices" :actor="actor" :busy="settings.save.busy.value" :problem="settings.save.problem.value" @save="save" />
  </AppPage>
</template>

<style scoped>
.group { display: grid; gap: var(--space-3); }
.system { margin: 0; color: var(--text-dim); font-size: var(--text-sm); font-weight: var(--weight-strong); }
.cards { display: grid; gap: var(--space-3); }
</style>
