<script setup lang="ts">
/**
 * The Groups tab: every group, searched and sorted by the hub (`?q=`), with how many people are in it. A group opens
 * beside the list (`?group=<id>`) with its members, to add or take out. "New group" (`?add=1`). A provider's group
 * claims put people into the groups of the same names at each sign-in.
 */
import { ActorId } from '@harness/core';
import { computed, reactive, ref, watch } from 'vue';
import { useRouteQuery } from '../../../app/url.ts';
import { ROUTES } from '../../../app/routes.ts';
import HubPicker from '../../../components/pickers/HubPicker.vue';
import ListSearch from '../../../components/query/ListSearch.vue';
import { hubListQuery, useListQuery } from '../../../state/query.ts';
import { useStores } from '../../../state/stores.ts';
import { UiAvatar, UiBanner, UiButton, UiDialog, UiInput, UiSkeleton } from '../../../ui/index.ts';
import { useNow } from '../../../ui/now.ts';
import BrowserFrame from '../BrowserFrame.vue';
import BrowserRow from '../BrowserRow.vue';

const { admin, toasts } = useStores();
const people = admin.people;
const now = useNow(60_000);
const query = useRouteQuery(ROUTES.people);
const search = useListQuery('groups');
const opened = query.text('group', { push: true });
const add = query.text('add', { push: true });
const adding = computed({ get: () => add.value === '1', set: (open) => { add.value = open ? '1' : ''; } });
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) opened.value = ''; } });

const filter = computed(() => hubListQuery(search.value));
const narrowed = computed(() => Object.keys(filter.value).some((key) => key !== 'sort'));
const items = computed(() => people.groups.items.value);
const open = computed(() => people.members.value.value);
const picked = ref<readonly string[]>([]);
const draft = reactive({ name: '', about: '' });
const tried = ref(false);
const nameError = computed(() => (tried.value && draft.name.trim() === '' ? 'Give the group a name.' : ''));

watch(filter, (value, before) => { if (JSON.stringify(value) !== JSON.stringify(before)) void people.groups.load(value); }, { immediate: true });
watch(opened, (id) => {
  const group = ActorId.safeParse(id);
  if (group.success) void people.openGroup(group.data); else people.members.reset();
}, { immediate: true });
watch(adding, (isOpen) => { if (isOpen) { Object.assign(draft, { name: '', about: '' }); tried.value = false; } });

async function makeGroup(): Promise<void> {
  tried.value = true;
  if (nameError.value !== '') return;
  const done = await people.addGroup({ name: draft.name.trim(), about: draft.about.trim() });
  if (!done.ok) return;
  adding.value = false;
  toasts.ok(`${draft.name.trim()} made`);
  opened.value = done.value.id;
}

async function member(user: string, member: boolean): Promise<void> {
  const group = open.value?.group;
  const who = ActorId.safeParse(user);
  if (group === undefined || !who.success) return;
  const done = await people.membership({ group: group.id, user: who.data, member });
  if (!done.ok) toasts.error(done.problem);
}

function addMembers(ids: readonly string[]): void {
  for (const id of ids) void member(id, true);
  picked.value = [];
}
</script>

<template>
  <BrowserFrame
    v-model:panel="panel" label="Groups" :loading="people.groups.loading.value" :loaded="people.groups.loaded.value" :problem="people.groups.problem.value"
    :empty="items.length === 0" :has-more="people.groups.hasMore.value" :loading-more="people.groups.loadingMore.value"
    empty-icon="users" :empty-title="narrowed ? 'No group matches' : 'No groups yet'"
    :empty-body="narrowed ? 'Try a wider filter.' : 'Groups gather people for budgets, policies and settings. A provider\'s group claims fill groups of the same name.'"
    :panel-title="open?.group.name ?? 'Group'" :panel-subtitle="open === undefined ? '' : `${open.group.members} ${open.group.members === 1 ? 'person' : 'people'}`"
    @more="people.groups.more()" @retry="people.groups.load()"
  >
    <template #filters>
      <ListSearch v-model="search" list="groups" label="groups" :count="items.length" :more="people.groups.hasMore.value">
        <UiButton variant="primary" icon="plus" data-testid="add-group" @click="adding = true">New group</UiButton>
      </ListSearch>
    </template>
    <BrowserRow
      v-for="group in items" :key="group.id" :title="group.name" :detail="group.about" :at="group.createdAt" :now="now"
      :selected="opened === group.id" :testid="`group-${group.id}`" @open="opened = group.id"
    >
      <template #mark><UiAvatar :name="group.name" :size="28" kind="agent" /></template>
      <template #figures><span class="count">{{ group.members }} {{ group.members === 1 ? 'person' : 'people' }}</span></template>
    </BrowserRow>
    <template #panel>
      <div class="group-panel" data-testid="group-panel">
        <UiBanner v-if="people.members.problem.value !== ''" tone="danger">{{ people.members.problem.value }}</UiBanner>
        <UiSkeleton v-if="open === undefined && people.members.loading.value" shape="lines" :lines="5" />
        <template v-if="open">
          <p v-if="open.group.about !== ''" class="about">{{ open.group.about }}</p>
          <HubPicker v-model="picked" source="person" label="Add people" placeholder="Find people" :disabled="people.save.busy.value" testid="group-add-people" @update:model-value="addMembers" />
          <ul v-if="open.items.length > 0" class="members">
            <li v-for="user in open.items" :key="user.id" class="member">
              <UiAvatar :name="user.name" :size="28" />
              <span class="who"><span class="name">{{ user.name }}</span><span class="email">{{ user.email }}</span></span>
              <UiButton size="sm" variant="ghost" icon="minus" :disabled="people.save.busy.value" :aria-label="`Take ${user.name} out`" @click="member(user.id, false)">Remove</UiButton>
            </li>
          </ul>
          <p v-else class="about">Nobody is in this group yet.</p>
          <p v-if="open.cursor !== undefined" class="about">Showing the first {{ open.items.length }}.</p>
        </template>
      </div>
    </template>
  </BrowserFrame>
  <UiDialog v-model:open="adding" title="New group" description="Name it as your sign-in provider names the group, and its group claims fill it at each sign-in." width="480px">
    <form class="form" novalidate data-testid="add-group-form" @submit.prevent="makeGroup">
      <UiInput v-model="draft.name" label="Name" name="name" autocomplete="off" required :error="nameError" autofocus />
      <UiInput v-model="draft.about" label="About" name="about" autocomplete="off" placeholder="What the group is for (optional)" />
      <UiBanner v-if="people.save.problem.value !== ''" tone="danger">{{ people.save.problem.value }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="adding = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="people.save.busy.value" data-testid="add-group-save" @click="makeGroup">Make group</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.count { color: var(--text-dim); font-size: var(--text-sm); white-space: nowrap; }
.group-panel { display: grid; gap: var(--space-4); }
.about { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.members { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius-md); }
.member { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); animation: ui-fade-in var(--medium) var(--ease); }
.member + .member { border-top: 1px solid var(--border); }
.who { display: grid; min-width: 0; }
.name { font-weight: var(--weight-medium); }
.email { overflow: hidden; color: var(--text-dim); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.form { display: grid; gap: var(--space-4); }
</style>
