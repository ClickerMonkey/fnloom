<script setup lang="ts">
/**
 * The fns catalogue: every fn of every system with how its runs have gone, searched, filtered and sorted by the hub
 * (the query in the URL: `system:fs paused:yes sort:-runs`). A fn's name opens its page; its numbers open its runs.
 */
import { computed, watch } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import ListSearch from '../../components/query/ListSearch.vue';
import { hubListQuery, useListQuery } from '../../state/query.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import FnList from '../components/FnList.vue';
import LoadState from '../components/LoadState.vue';

const { admin } = useStores();
const fns = admin.fns;
const now = useNow(30_000);
const search = useListQuery('fns');
const filter = computed(() => hubListQuery(search.value));
const narrowed = computed(() => Object.keys(filter.value).some((key) => key !== 'sort'));

watch(filter, (value, before) => { if (JSON.stringify(value) !== JSON.stringify(before)) { void fns.load(value); } }, { immediate: true });
</script>

<template>
  <AppPage title="Fns" description="Every fn of every system, and how its runs have gone.">
    <div class="fns-page">
      <ListSearch v-model="search" list="fns" label="fns" :count="fns.items.value.length" :more="fns.hasMore.value" :partial="fns.partial.value" />
      <LoadState
        :loading="fns.loading.value" :problem="fns.problem.value" :ready="fns.loaded.value" :empty="fns.items.value.length === 0" :lines="8"
        empty-icon="fn" :empty-title="narrowed ? 'No fns match' : 'No fns yet'" :empty-body="narrowed ? 'Try a wider filter.' : 'Fns show here as systems pair.'" @retry="fns.load()"
      >
        <FnList :fns="fns.items.value" :now="now" :runs-of="links.fnRuns" />
        <div v-if="fns.hasMore.value" class="more">
          <UiButton variant="ghost" :loading="fns.loadingMore.value" data-testid="more" @click="fns.more()">Show more</UiButton>
        </div>
      </LoadState>
    </div>
  </AppPage>
</template>

<style scoped>
.fns-page { display: grid; gap: var(--space-3); min-width: 0; }
.more { display: flex; justify-content: center; }
</style>
