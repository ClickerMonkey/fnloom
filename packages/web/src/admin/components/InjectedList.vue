<script setup lang="ts">
/**
 * Injected items as an admin reads them (`InjectionView`s, in the order shown), with a switch and an order for each.
 * `per="agent"` is an agent's Injected tab: each row is an item (its system as a pill, its title, its key linking to
 * the item's page) with the target that took it in, and a total line over the list (how many are in, their tokens).
 * `per="item"` is a context item's page: each row is an agent it reaches (a pill opening the agent, whose Injected tab
 * has the rest). Every row shows its state and, when left out, why; its tokens and the detail it gets; who last
 * switched it; and its text as the model reads it, collapsed, as markdown. A switch or a new order is per agent:
 * `switch` and `reorder` say so, and `busy` names the row being saved. Rows wrap on a narrow screen.
 */
import type { InjectionView } from '@harness/core';
import { computed, ref } from 'vue';
import { links } from '../../app/routes.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiEmpty, UiIconButton, UiInput, UiMarkdown, UiSwitch, relativeTime, fullTime } from '../../ui/index.ts';
import { injectedTotal, injectionState, movedOrder, parseOrder, sourceWords, totalLine, viaWords } from '../logic/injected.ts';
import { viewKey } from '../state/injected.ts';
import LoadState from './LoadState.vue';

const props = withDefaults(defineProps<{
  views: readonly InjectionView[];
  /** An agent's tab (rows are items) or an item's page (rows are agents). */
  per: 'agent' | 'item';
  loading?: boolean;
  problem?: string;
  /** The row being saved (`viewKey`), '' for none. */
  busy?: string;
  now: number;
}>(), { loading: false, problem: '', busy: '' });
const emit = defineEmits<{ switch: [view: InjectionView, on: boolean]; reorder: [view: InjectionView, order: number | null]; retry: [] }>();

const { admin } = useStores();
const total = computed(() => injectedTotal(props.views));
/** The order being typed per row, until it is applied. */
const typed = ref<Record<string, string>>({});
const orderText = (view: InjectionView): string => typed.value[viewKey(view)] ?? String(view.order);
const orderError = (view: InjectionView): string => (parseOrder(orderText(view)) === undefined ? 'A whole number from 0 to 1000' : '');

function applyOrder(view: InjectionView): void {
  const order = parseOrder(orderText(view));
  const key = viewKey(view);
  if (order === undefined || order === view.order) { typed.value = Object.fromEntries(Object.entries(typed.value).filter(([k]) => k !== key)); return; }
  typed.value = Object.fromEntries(Object.entries(typed.value).filter(([k]) => k !== key));
  emit('reorder', view, order);
}

function move(index: number, step: -1 | 1): void {
  const view = props.views[index];
  const order = movedOrder(props.views, index, step);
  if (view !== undefined && order !== undefined) { emit('reorder', view, order); }
}
</script>

<template>
  <LoadState :loading="loading" :problem="problem" :ready="views.length > 0 || !loading" :empty="false" :lines="4" data-testid="injected-list" @retry="emit('retry')">
    <p v-if="per === 'agent'" class="total" data-testid="injected-total">
      {{ totalLine(total) }}<span v-if="total.of > 0" class="dim"> · estimated, outside any chat: a chat's own systems and fn setting can leave more out</span>
    </p>
    <UiEmpty
      v-if="views.length === 0 && !loading" icon="layers" :title="per === 'agent' ? 'Nothing injected' : 'Reaches no agent'"
      :body="per === 'agent' ? 'No context item or hook targets this agent.' : 'None of its targets hits an agent now.'"
    />
    <ol v-else class="rows">
      <li
        v-for="(view, index) in views" :key="viewKey(view)" class="row" :class="{ out: !injectionState(view).in }" data-testid="injected-row"
        :data-context="view.context" :data-agent="view.agent" :data-state="view.leftOut?.why ?? 'in'"
      >
        <div class="head">
          <span class="order" :title="`Order ${view.order}: lower comes first`">#{{ view.order }}</span>
          <template v-if="per === 'agent'">
            <FnPill :name="view.system" />
            <strong class="title">{{ view.title }}</strong>
          </template>
          <FnPill v-else :name="view.agent" />
          <UiBadge :tone="injectionState(view).tone" data-testid="injected-state">{{ injectionState(view).label }}</UiBadge>
          <UiBadge v-if="view.source.type === 'hook'">{{ sourceWords(view) }}</UiBadge>
        </div>
        <p v-if="view.leftOut" class="why" data-testid="injected-why">{{ view.leftOut.reason }}</p>
        <dl class="meta">
          <div v-if="per === 'agent'">
            <dt>Key</dt>
            <dd>
              <RouterLink v-if="view.source.type === 'context'" :to="links.contextItem(view.context)" class="key">{{ view.context }}</RouterLink>
              <code v-else>{{ view.context }}</code>
            </dd>
          </div>
          <div><dt>Came in</dt><dd data-testid="injected-via">{{ viaWords(view) }}</dd></div>
          <div><dt>Size</dt><dd>about {{ view.tokens.toLocaleString('en-US') }} tokens{{ view.detail === 'summary' ? ', as its summary' : '' }}</dd></div>
          <div v-if="view.switched">
            <dt>Changed</dt>
            <dd>by {{ admin.actors.nameOf(view.switched.by) }} <time :datetime="new Date(view.switched.at).toISOString()" :title="fullTime(view.switched.at)">{{ relativeTime(view.switched.at, now) }}</time></dd>
          </div>
        </dl>
        <details class="text" data-testid="injected-text">
          <summary>Text as the model reads it</summary>
          <div class="body"><UiMarkdown :source="view.text" /></div>
        </details>
        <div class="controls">
          <UiSwitch
            :model-value="view.on" label="On for this agent" :disabled="busy === viewKey(view)" data-testid="injected-on"
            @update:model-value="(on: boolean) => emit('switch', view, on)"
          />
          <div class="ordering">
            <UiIconButton icon="chevron-up" size="sm" label="Earlier" :disabled="busy === viewKey(view) || movedOrder(views, index, -1) === undefined" data-testid="injected-up" @click="move(index, -1)" />
            <UiIconButton icon="chevron-down" size="sm" label="Later" :disabled="busy === viewKey(view) || movedOrder(views, index, 1) === undefined" data-testid="injected-down" @click="move(index, 1)" />
            <UiInput
              class="order-input" size="sm" type="number" label="Order" hide-label :model-value="orderText(view)" :error="orderError(view)" :disabled="busy === viewKey(view)"
              data-testid="injected-order" @update:model-value="(text: string) => { typed[viewKey(view)] = text; }" @enter="applyOrder(view)" @focusout="applyOrder(view)"
            />
            <UiButton v-if="view.switched" size="sm" variant="ghost" :disabled="busy === viewKey(view)" data-testid="injected-reset" @click="emit('reorder', view, null)">Own order</UiButton>
          </div>
        </div>
      </li>
    </ol>
  </LoadState>
</template>

<style scoped>
.total { margin: 0 0 var(--space-3); font-weight: var(--weight-medium); }
.dim { color: var(--text-faint); font-weight: normal; font-size: var(--text-sm); }
.rows { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.row { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.row.out { background: var(--surface-2); }
.row.out .title { color: var(--text-dim); }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); min-width: 0; }
.order { color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.title { min-width: 0; overflow-wrap: anywhere; }
.why { margin: 0; color: var(--warn); font-size: var(--text-sm); }
.meta { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0; font-size: var(--text-sm); }
.meta div { display: flex; gap: var(--space-1); min-width: 0; }
.meta dt { color: var(--text-faint); }
.meta dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.key { color: var(--accent); text-decoration: none; font-family: var(--mono); font-size: var(--text-xs); }
.key:hover { text-decoration: underline; }
.text summary { cursor: pointer; color: var(--text-dim); font-size: var(--text-sm); }
.text .body { margin-top: var(--space-2); padding: var(--space-2) var(--space-3); border-left: 2px solid var(--border); max-height: 360px; overflow: auto; }
.controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); }
.ordering { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
.order-input { width: 96px; }
</style>
