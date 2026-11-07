<script setup lang="ts">
/** The app shell: the side navigation (when signed in) and the current page. */
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import AppNav from './components/AppNav.vue';

const route = useRoute();
const bare = computed(() => route.meta['public'] === true);
</script>

<template>
  <div class="shell" :class="{ bare }">
    <AppNav v-if="!bare" class="nav" />
    <main class="page"><RouterView /></main>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); height: 100%; }
.shell.bare { grid-template-columns: minmax(0, 1fr); }
.page { min-width: 0; min-height: 0; overflow: auto; }
@media (max-width: 760px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
}
</style>
