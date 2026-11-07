<script setup lang="ts">
/** The frame of a side panel (run details, the tree, an LLM call, settings): its title, Back and Close, then its body, which scrolls. */
import { UiIconButton } from '../../ui/index.ts';

withDefaults(defineProps<{ title: string; subtitle?: string; back?: boolean }>(), { subtitle: '', back: false });
const emit = defineEmits<{ close: []; back: [] }>();
const slots = defineSlots<{ default: () => unknown; actions?: () => unknown }>();
</script>

<template>
  <section class="panel" :aria-label="title">
    <header class="head">
      <UiIconButton v-if="back" icon="chevron-left" label="Back" @click="emit('back')" />
      <div class="titles">
        <h2 class="title">{{ title }}</h2>
        <p v-if="subtitle !== ''" class="subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="slots.actions" class="actions"><slot name="actions" /></div>
      <UiIconButton icon="x" label="Close" data-testid="panel-close" @click="emit('close')" />
    </header>
    <div class="body"><slot /></div>
  </section>
</template>

<style scoped>
.panel { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; min-width: 0; min-height: 0; }
.head { display: flex; align-items: center; gap: var(--space-2); min-height: var(--topbar); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4); border-bottom: 1px solid var(--border); }
.titles { display: grid; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subtitle { margin: 0; color: var(--text-faint); font-size: var(--text-xs); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; gap: var(--space-1); }
.body { min-height: 0; overflow-y: auto; padding: var(--space-4); padding-bottom: max(var(--space-4), var(--safe-bottom)); }
</style>
