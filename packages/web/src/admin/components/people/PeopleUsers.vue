<script setup lang="ts">
/**
 * The People tab: everyone who can sign in, searched, filtered and sorted by the hub (`?q=`), with how each signs in.
 * A person opens beside the list (`?user=<email>`): their role, whether they can sign in, how they signed in, and
 * their groups. "Add person" (`?add=1`) invites someone by email: their first sign-in through a provider links to them.
 */
import { type ActorId, type PersonView, type SsoProviderView, type UserRole } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouteQuery } from '../../../app/url.ts';
import { ROUTES } from '../../../app/routes.ts';
import ListSearch from '../../../components/query/ListSearch.vue';
import { hubListQuery, useListQuery } from '../../../state/query.ts';
import { useStores } from '../../../state/stores.ts';
import { UiAvatar, UiBadge, UiButton } from '../../../ui/index.ts';
import { useNow } from '../../../ui/now.ts';
import BrowserFrame from '../BrowserFrame.vue';
import BrowserRow from '../BrowserRow.vue';
import { signInLabels } from '../../logic/people.ts';
import AddPersonDialog from './AddPersonDialog.vue';
import PersonPanel from './PersonPanel.vue';
import type { NewPerson } from '../../state/people.ts';

const props = defineProps<{ providers: readonly SsoProviderView[] }>();

const { admin, toasts, session } = useStores();
const people = admin.people;
const now = useNow(60_000);
const query = useRouteQuery(ROUTES.people);
const search = useListQuery('users');
const opened = query.text('user', { push: true });
const add = query.text('add', { push: true });
const adding = computed({ get: () => add.value === '1', set: (open) => { add.value = open ? '1' : ''; } });
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) opened.value = ''; } });

const filter = computed(() => hubListQuery(search.value));
const narrowed = computed(() => Object.keys(filter.value).some((key) => key !== 'sort'));
const items = computed(() => people.users.items.value);
const person = computed(() => people.person.value.value);
const me = computed(() => session.user.value?.id);

watch(filter, (value, before) => { if (JSON.stringify(value) !== JSON.stringify(before)) void people.users.load(value); }, { immediate: true });
watch(opened, (email) => { if (email !== '') void people.openPerson(email); else people.person.reset(); }, { immediate: true });

async function addPerson(person: NewPerson): Promise<void> {
  const done = await people.addPerson(person);
  if (!done.ok) return;
  adding.value = false;
  toasts.ok(`${person.name} added`, props.providers.length === 0 ? 'They can sign in once a sign-in provider is configured.' : 'Their first sign-in links to them by their email.');
}

async function change(target: PersonView, change: { role?: UserRole; disabled?: boolean; group?: { id: ActorId; member: boolean } }): Promise<void> {
  const done = change.group === undefined
    ? await people.update({ user: target.id, ...(change.role === undefined ? {} : { role: change.role }), ...(change.disabled === undefined ? {} : { disabled: change.disabled }) })
    : await people.membership({ group: change.group.id, user: target.id, member: change.group.member });
  if (!done.ok) { toasts.error(done.problem); return; }
  if (change.role !== undefined) toasts.ok(change.role === 'admin' ? `${target.name} is an admin` : `${target.name} is a member`);
  if (change.disabled !== undefined) toasts.ok(change.disabled ? `${target.name} can't sign in now` : `${target.name} can sign in again`);
}
</script>

<template>
  <BrowserFrame
    v-model:panel="panel" label="People" :loading="people.users.loading.value" :loaded="people.users.loaded.value" :problem="people.users.problem.value"
    :empty="items.length === 0" :has-more="people.users.hasMore.value" :loading-more="people.users.loadingMore.value"
    empty-icon="user" :empty-title="narrowed ? 'Nobody matches' : 'Nobody yet'" :empty-body="narrowed ? 'Try a wider filter.' : 'Add the people who can sign in.'"
    :panel-title="person?.name ?? 'Person'" :panel-subtitle="person?.email ?? opened" @more="people.users.more()" @retry="people.users.load()"
  >
    <template #filters>
      <ListSearch v-model="search" list="users" label="people" :count="items.length" :more="people.users.hasMore.value">
        <UiButton variant="primary" icon="plus" data-testid="add-person" @click="adding = true">Add person</UiButton>
      </ListSearch>
    </template>
    <BrowserRow
      v-for="row in items" :key="row.id" :title="row.name" :detail="row.email" :at="row.createdAt" :now="now"
      :selected="opened === row.email" :testid="`person-${row.id}`" @open="opened = row.email"
    >
      <template #mark><UiAvatar :name="row.name" :size="28" /></template>
      <template #badges>
        <UiBadge v-if="row.role === 'admin'" tone="accent">Admin</UiBadge>
        <UiBadge v-if="row.breakGlass" tone="warn" title="Keeps a password once sign-in providers are on">Break-glass</UiBadge>
        <UiBadge v-if="row.disabled" tone="danger">Can't sign in</UiBadge>
      </template>
      <template #figures>
        <!-- one figure per way, so a narrow row wraps them instead of running past its edge -->
        <span v-for="way in signInLabels(row)" :key="way" class="way">{{ way }}</span>
        <span v-if="signInLabels(row).length === 0" class="way">Not signed in yet</span>
      </template>
    </BrowserRow>
    <template #panel>
      <PersonPanel
        :person="person" :loading="people.person.loading.value" :problem="people.person.problem.value" :providers="providers" :me="me" :now="now"
        :busy="people.save.busy.value" @change="(c) => person && change(person, c)" @retry="people.openPerson(opened)"
      />
    </template>
  </BrowserFrame>
  <AddPersonDialog v-model:open="adding" :providers="providers" :busy="people.save.busy.value" :problem="people.save.problem.value" @save="addPerson" />
</template>

<style scoped>
.way { color: var(--text-dim); font-size: var(--text-sm); }
</style>
