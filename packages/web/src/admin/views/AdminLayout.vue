<script setup lang="ts">
/**
 * The admin area's frame: its section nav over the section's page. While any admin page is open it follows the hub's
 * live changes (system status, new pairing requests).
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useStores } from '../../state/stores.ts';
import AdminNav from '../components/AdminNav.vue';
import { adminNav } from '../logic/nav.ts';

const { admin } = useStores();
const route = useRoute();
const entries = computed(() => adminNav(route, { systems: admin.systems.pending.value }));

onMounted(() => { admin.start(); });
onBeforeUnmount(() => { admin.stop(); });
</script>

<template>
  <div class="admin" data-testid="admin">
    <AdminNav :entries="entries" />
    <RouterView />
  </div>
</template>

<style scoped>
.admin { display: grid; grid-template-rows: auto 1fr; min-width: 0; min-height: 100%; }
</style>
