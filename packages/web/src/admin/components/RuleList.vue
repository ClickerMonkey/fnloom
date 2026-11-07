<script setup lang="ts">
/** A card of rule rows with a heading, a line about them, and an Add button. */
import { UiButton } from '../../ui/index.ts';

withDefaults(defineProps<{ title: string; description?: string; add?: string; testid?: string }>(), { description: '', add: '', testid: '' });
const emit = defineEmits<{ add: [] }>();
defineSlots<{ default: () => unknown }>();
</script>

<template>
  <section class="rule-list" :data-testid="testid || undefined">
    <header class="head">
      <div class="titles">
        <h2 class="title">{{ title }}</h2>
        <p v-if="description !== ''" class="description">{{ description }}</p>
      </div>
      <UiButton v-if="add !== ''" icon="plus" data-testid="add" @click="emit('add')">{{ add }}</UiButton>
    </header>
    <ul class="rows"><slot /></ul>
  </section>
</template>

<style scoped>
.rule-list { display: grid; gap: var(--space-3); min-width: 0; }
.head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-2) var(--space-4); }
.titles { min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.description { margin: 2px 0 0; color: var(--text-dim); font-size: var(--text-sm); }
.rows { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.rows:empty { display: none; }
</style>
