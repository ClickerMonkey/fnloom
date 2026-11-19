<script setup lang="ts">
/**
 * People (SSO): who can sign in, the groups they are in, and how they sign in, one tab each in the URL
 * (`/admin/people`, `/admin/people/groups`, `/admin/people/sign-in`). Each tab keeps its own search and open item in
 * the query, so moving between tabs starts each fresh.
 */
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useStores } from '../../state/stores.ts';
import { UiTabs, type TabItem } from '../../ui/index.ts';
import PeopleGroups from '../components/people/PeopleGroups.vue';
import PeopleSignIn from '../components/people/PeopleSignIn.vue';
import PeopleUsers from '../components/people/PeopleUsers.vue';
import { PeopleTab } from '../sections.ts';

const { admin } = useStores();
const people = admin.people;
const route = useRoute();
const router = useRouter();

const tab = computed<PeopleTab>({
  get: () => {
    const read = PeopleTab.safeParse(route.params['tab']);
    return read.success ? read.data : 'users';
  },
  // a tab is a place (Back returns to it), and starts without the other tab's search or open item
  set: (next) => { void router.push(links.people(next)); },
});
const providers = computed(() => people.signIn.value.value?.providers ?? []);
const tabs = computed<readonly TabItem<PeopleTab>[]>(() => [
  { value: 'users', label: 'People', icon: 'user' },
  { value: 'groups', label: 'Groups', icon: 'users' },
  { value: 'sign-in', label: 'Sign-in', icon: 'key', count: providers.value.length },
]);

onMounted(() => { void people.loadSignIn(people.signIn.value.value !== undefined); });
</script>

<template>
  <AppPage title="People" description="Who can sign in, the groups they are in, and how they sign in.">
    <UiTabs v-model="tab" :tabs="tabs" label="People" />
    <PeopleUsers v-if="tab === 'users'" :providers="providers" />
    <PeopleGroups v-else-if="tab === 'groups'" />
    <PeopleSignIn v-else />
  </AppPage>
</template>
