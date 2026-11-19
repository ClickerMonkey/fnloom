<script setup lang="ts">
/**
 * One fn's page (`/admin/systems/:name/fns/:fn`): its header, the way back to its system (or the fleet instance it is
 * routed to), and everything about it in `FnDetails`, the same component the fn modal shows. The page keeps the
 * period (`?days=7|30|90`) and the payload form (`?form=`) in the URL; another fn, a run and all its runs open as pages.
 */
import { QualifiedName } from '@harness/core';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { z } from 'zod';
import AppPage from '../../app/AppPage.vue';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import FnDetails from '../../fns/components/FnDetails.vue';
import { PayloadForm } from '../../fns/logic/facts.ts';
import { useStores } from '../../state/stores.ts';
import { UiIcon } from '../../ui/index.ts';
import { FN_PERIODS, type FnPeriod } from '../state/fn.ts';

const { admin } = useStores();
const route = useRoute();
const router = useRouter();
const query = useRouteQuery(ROUTES.fn);
const Period = z.enum(['7', '30', '90']);
const days = query.choice('days', Period, '7');
const period = computed<FnPeriod>({
  get: () => FN_PERIODS.find((d) => String(d) === days.value) ?? 7,
  set: (value) => { days.value = Period.parse(String(value)); },
});
/** The payload as its kind writes it for people (a query's SQL, a program), with the stored JSON one switch away (`?form=stored`). */
const form = query.choice('form', PayloadForm, 'readable');

const name = computed(() => {
  const parsed = QualifiedName.safeParse(`${String(route.params['name'])}/${String(route.params['fn'])}`);
  return parsed.success ? parsed.data : undefined;
});
const record = computed(() => admin.fn.record.value.value);
const back = computed(() => {
  const r = record.value;
  if (r === undefined) { return undefined; }
  return r.decl.routing?.to === 'instance' ? links.instance(r.system, r.decl.routing.instance, 'fns') : links.system(r.system, 'fns');
});
</script>

<template>
  <AppPage :title="name ? fnLabel(name) : 'Fn'" :description="record?.decl.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink v-if="record && back" :to="back" class="crumb" data-testid="back-to-system">
        <UiIcon name="chevron-left" :size="14" />{{ record.decl.routing?.to === 'instance' ? `${record.system}@${record.decl.routing.instance}` : record.system }}
      </RouterLink>
    </template>
    <FnDetails
      v-if="name" v-model:days="period" v-model:form="form" :name="name" :describe="false"
      @run="router.push(links.runs({ run: $event }))" @runs="router.push(links.fnRuns($event))"
    />
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
</style>
