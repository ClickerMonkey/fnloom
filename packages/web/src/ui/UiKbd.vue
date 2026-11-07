<script setup lang="ts">
/** A key or key combination, such as `Ctrl` `K`. */
defineProps<{ keys: readonly string[] }>();
</script>

<template>
  <span class="ui-kbd"><kbd v-for="key in keys" :key="key">{{ key }}</kbd></span>
</template>

<style scoped>
.ui-kbd { display: inline-flex; gap: 3px; }
kbd {
  min-width: 20px; height: 20px; padding: 0 5px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 5px;
  background: var(--surface); color: var(--text-dim); font: var(--weight-medium) 11px/17px var(--mono); text-align: center;
}
</style>
