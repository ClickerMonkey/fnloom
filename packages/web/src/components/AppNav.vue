<script setup lang="ts">
/** The side navigation: chat, systems and settings. Collapses to a top bar on narrow screens. */
import { ROUTES } from '../router.ts';

const links = [
  { to: { name: ROUTES.chat }, label: 'Chat' },
  { to: { name: ROUTES.systems }, label: 'Systems' },
  { to: { name: ROUTES.settings }, label: 'Settings' },
] as const;
</script>

<template>
  <nav class="nav" aria-label="Main">
    <div class="brand">Harness</div>
    <RouterLink v-for="link in links" :key="link.label" :to="link.to" class="link" active-class="active">{{ link.label }}</RouterLink>
  </nav>
</template>

<style scoped>
.nav { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-4); background: var(--surface); border-right: 1px solid var(--border); }
.brand { font-weight: 650; letter-spacing: -0.01em; padding: var(--space-2) var(--space-3) var(--space-4); }
.link { padding: var(--space-2) var(--space-3); border-radius: var(--radius); color: var(--text-dim); transition: background var(--fast) var(--ease), color var(--fast) var(--ease); }
.link:hover { background: var(--surface-2); color: var(--text); }
.link.active { background: var(--accent-soft); color: var(--text); }
@media (max-width: 760px) {
  .nav { flex-direction: row; align-items: center; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: var(--space-2) var(--space-3); }
  .brand { padding: 0 var(--space-3) 0 0; }
}
</style>
