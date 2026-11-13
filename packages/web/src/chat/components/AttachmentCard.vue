<script setup lang="ts">
/**
 * A typed attachment a fn added to an answer: drawn by its system's attachment renderer (the fs diff view); when it has
 * none and its data is a result table (a query's rows), by the result view with the hub's visuals (`hub/visuals`, which
 * every system contributes to); else as its title and a short look at its data.
 */
import { HUB_VISUALS, QualifiedName, ResultTable, type Json } from '@harness/core';
import { computed, ref } from 'vue';
import { UiIcon } from '../../ui/index.ts';
import ResultBlock from '../../components/results/ResultBlock.vue';
import { fnLabel } from '../logic/labels.ts';
import RendererHost from './RendererHost.vue';
import type { RenderView } from './types.ts';

const props = withDefaults(defineProps<{
  title: string;
  attachment: QualifiedName;
  data: Json;
  view?: RenderView<'attachment'> | undefined;
  /** Where a result view keeps the visual the person picked (the message part's key). */
  viewKey?: string;
}>(), { view: undefined, viewKey: '' });

const open = ref(false);
const peek = computed(() => JSON.stringify(props.data, null, 2));
const table = computed(() => { const parsed = ResultTable.safeParse(props.data); return parsed.success ? parsed.data : undefined; });
const registry = QualifiedName.parse(HUB_VISUALS);
</script>

<template>
  <section class="attachment" data-testid="attachment" :data-attachment="attachment">
    <header class="head">
      <UiIcon name="sparkles" :size="14" />
      <span class="title">{{ title }}</span>
      <span class="kind">{{ fnLabel(attachment) }}</span>
    </header>
    <RendererHost v-if="view" :view="view" :label="title" @inspect="open = true" />
    <ResultBlock v-else-if="table" :table="table" :title="title" :registry="registry" :view-key="viewKey" />
    <template v-else>
      <pre class="peek" :class="{ open }">{{ peek }}</pre>
      <button v-if="peek.split('\n').length > 6" type="button" class="toggle" @click="open = !open">{{ open ? 'Show less' : 'Show all' }}</button>
    </template>
  </section>
</template>

<style scoped>
.attachment { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; color: var(--text-dim); }
.title { flex: 1; min-width: 0; color: var(--text); font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind { flex: none; color: var(--text-faint); font-size: var(--text-xs); }
.peek { margin: 0; max-height: 7.5em; overflow: hidden; padding: var(--space-2); border-radius: var(--radius-sm); background: var(--code-bg); font-family: var(--mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.peek.open { max-height: 320px; overflow: auto; }
.toggle { justify-self: start; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: var(--text-sm); }
</style>
