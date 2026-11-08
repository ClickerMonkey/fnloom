<script setup lang="ts">
/**
 * One side of an MCP's rules (what it includes, or what it excludes): for each part (systems, fns, types, context,
 * resources) its entries as chips to remove, and a field to add one, with suggestions from the catalog. An entry is
 * checked as it is added (a fn glob, a #tag, a URI prefix on system@instance); a bad one says why and isn't added.
 */
import type { McpSelector } from '@harness/core';
import { ref, useId } from 'vue';
import { UiButton, UiIconButton } from '../../ui/index.ts';
import { addEntry, entryText, removeEntry, SELECTOR_PARTS, SELECTOR_WORDS, type SelectorPart } from '../logic/mcps.ts';

const props = withDefaults(defineProps<{
  title: string;
  about: string;
  selector: McpSelector;
  /** Names to suggest for each part (systems, fns, types, context the catalog has). */
  suggestions?: Partial<Record<SelectorPart, readonly string[]>>;
  tone?: 'include' | 'exclude';
  testid: string;
}>(), { suggestions: () => ({}), tone: 'include' });
const emit = defineEmits<{ change: [selector: McpSelector] }>();

const id = useId();
const drafts = ref<Partial<Record<SelectorPart, string>>>({});
const problems = ref<Partial<Record<SelectorPart, string>>>({});

function typed(part: SelectorPart, event: Event): void {
  if (event.target instanceof HTMLInputElement) { drafts.value = { ...drafts.value, [part]: event.target.value }; }
}

function add(part: SelectorPart): void {
  const result = addEntry(props.selector, part, drafts.value[part] ?? '');
  if (!result.ok) { problems.value = { ...problems.value, [part]: result.problem }; return; }
  problems.value = { ...problems.value, [part]: '' };
  drafts.value = { ...drafts.value, [part]: '' };
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
          <UiIconButton size="sm" icon="x" :label="`Remove ${text}`" @click="emit('change', removeEntry(selector, part, i))" />
        </li>
      </ul>
      <form class="add" @submit.prevent="add(part)">
        <input
          :value="drafts[part] ?? ''" class="field" :placeholder="SELECTOR_WORDS[part].placeholder" :list="`${id}-${part}`" :aria-label="`Add to ${SELECTOR_WORDS[part].label}`"
          :aria-invalid="problems[part] ? 'true' : undefined" :data-testid="`${testid}-${part}-input`"
          @input="typed(part, $event)"
        >
        <datalist :id="`${id}-${part}`"><option v-for="name in suggestions[part] ?? []" :key="name" :value="name" /></datalist>
        <UiButton type="submit" size="sm" icon="plus" :data-testid="`${testid}-${part}-add`">Add</UiButton>
      </form>
      <p v-if="problems[part]" class="problem" role="alert">{{ problems[part] }}</p>
    </div>
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
.add { display: flex; gap: var(--space-2); }
.field {
  flex: 1; min-width: 0; height: var(--control-sm); padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text); font: inherit; font-size: var(--text-sm);
}
.field:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.field[aria-invalid='true'] { border-color: var(--danger); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-xs); }
</style>
