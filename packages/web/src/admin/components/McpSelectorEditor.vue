<script setup lang="ts">
/**
 * One side of an MCP's rules (what it includes, or what it excludes): for each part (systems, fns, types, context,
 * resources) its entries as chips to remove, and a picker to add one: search the hub, or type a glob, #tag or prefix
 * and press Enter. An entry is checked as it is added (a fn glob, a #tag, a URI prefix on system@instance); a bad one says why and isn't added.
 * A fn rule's condition (`FnMatch.when`, a gin predicate over its args) opens in gin's expression editor.
 */
import type { GinExprDef, McpSelector, PickSource } from '@harness/core';
import { computed, ref } from 'vue';
import HubPicker from '../../components/pickers/HubPicker.vue';
import { UiIconButton } from '../../ui/index.ts';
import { addEntry, entryText, removeEntry, SELECTOR_PARTS, SELECTOR_WORDS, setFnCondition, type SelectorPart } from '../logic/mcps.ts';
import FnConditionDialog from './FnConditionDialog.vue';

const props = withDefaults(defineProps<{
  title: string;
  about: string;
  selector: McpSelector;
  tone?: 'include' | 'exclude';
  testid: string;
}>(), { tone: 'include' });
const emit = defineEmits<{ change: [selector: McpSelector] }>();

/** What each part's picker searches. */
const SOURCES = { systems: 'system', fns: 'fn', types: 'type', context: 'context', resources: 'resource' } as const satisfies Record<SelectorPart, PickSource>;
/** Anything typed is offered as an entry; adding it checks it. */
const asTyped = (text: string): string | undefined => (text === '' ? undefined : text);
const problems = ref<Partial<Record<SelectorPart, string>>>({});

/** The fn rule whose condition is open, by its index; -1 for none. */
const conditionOf = ref(-1);
const conditionOpen = computed({ get: () => conditionOf.value >= 0, set: (isOpen: boolean) => { if (!isOpen) { conditionOf.value = -1; } } });
const conditionMatch = computed(() => props.selector.fns?.[conditionOf.value]);
const conditionTitle = computed(() => `Condition for ${entryText('fns', { fns: conditionMatch.value === undefined ? [] : [conditionMatch.value] })[0] ?? 'the rule'}`);
function saveCondition(when: GinExprDef | undefined): void {
  emit('change', setFnCondition(props.selector, conditionOf.value, when));
  conditionOf.value = -1;
}

function add(part: SelectorPart, entry: string | undefined): void {
  if (entry === undefined) { return; }
  const result = addEntry(props.selector, part, entry);
  if (!result.ok) { problems.value = { ...problems.value, [part]: result.problem }; return; }
  problems.value = { ...problems.value, [part]: '' };
  emit('change', result.value);
}
</script>

<template>
  <section class="selector" :class="tone" :data-testid="testid">
    <header class="head">
      <h3 class="title">{{ title }}</h3>
      <p class="about">{{ about }}</p>
    </header>
    <div v-for="part in SELECTOR_PARTS" :key="part" class="part" :data-part="part">
      <div class="label-row">
        <span class="label">{{ SELECTOR_WORDS[part].label }}</span>
        <span class="hint">{{ SELECTOR_WORDS[part].about }}</span>
      </div>
      <ul v-if="entryText(part, selector).length > 0" class="chips">
        <li v-for="(text, i) in entryText(part, selector)" :key="`${text}-${i}`" class="chip">
          <code>{{ text }}</code>
          <UiIconButton
            v-if="part === 'fns'" size="sm" icon="filter" :class="{ conditioned: selector.fns?.[i]?.when !== undefined }"
            :label="selector.fns?.[i]?.when === undefined ? `Add a condition to ${text}` : `Change the condition of ${text}`" :data-testid="`${testid}-fns-when-${i}`"
            @click="conditionOf = i"
          />
          <UiIconButton size="sm" icon="x" :label="`Remove ${text}`" @click="emit('change', removeEntry(selector, part, i))" />
        </li>
      </ul>
      <HubPicker
        :model-value="[]" :source="SOURCES[part]" :custom="asTyped" :label="`Add to ${SELECTOR_WORDS[part].label}`" hide-label :placeholder="SELECTOR_WORDS[part].placeholder"
        :testid="`${testid}-${part}-input`" @update:model-value="add(part, $event[0])"
      />
      <p v-if="problems[part]" class="problem" role="alert">{{ problems[part] }}</p>
    </div>
    <FnConditionDialog v-model:open="conditionOpen" :match="conditionMatch" :title="conditionTitle" @save="saveCondition" />
  </section>
</template>

<style scoped>
.selector { display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.selector.exclude { border-style: dashed; }
.head { display: grid; gap: 2px; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.about, .hint { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.hint { color: var(--text-faint); font-size: var(--text-xs); }
.part { display: grid; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.label-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; padding: 0 0 0 var(--space-2); border-radius: var(--radius-full); background: var(--surface-2); }
.chip code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
.include .chip { background: var(--accent-soft); }
.conditioned { color: var(--accent); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-xs); }
</style>
