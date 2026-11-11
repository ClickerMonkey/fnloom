<script setup lang="ts">
/** A note card, for the kit's preview tests: a title and its lines, or a calm empty state. */
defineProps<{ title?: string; lines?: string[] }>();
</script>

<template>
  <article class="note">
    <h3 v-if="title">{{ title }}</h3>
    <p v-if="!lines || lines.length === 0" class="empty">No lines yet.</p>
    <ul v-else><li v-for="line in lines" :key="line">{{ line }}</li></ul>
  </article>
</template>

<style scoped>
.note { padding: 12px; border: 1px solid var(--border, #ccc); border-radius: 8px; background: var(--surface, #fff); color: var(--text, #222); }
.empty { color: var(--text-dim, #666); }
</style>
