<script setup lang="ts">
/**
 * A card: a surface with an optional header (title, subtitle, `actions` slot), a body and a `footer` slot.
 * `interactive` cards lift on hover for rows that open something; the click is the parent's (wrap in a link or button).
 */
withDefaults(defineProps<{
  title?: string;
  subtitle?: string;
  interactive?: boolean;
  /** Tighter padding, for lists of cards. */
  compact?: boolean;
  /** No border or shadow: a section inside another surface. */
  flat?: boolean;
  /** No body padding: for lists whose rows bring their own. */
  flush?: boolean;
}>(), { title: '', subtitle: '', interactive: false, compact: false, flat: false, flush: false });

const slots = defineSlots<{ default?: () => unknown; actions?: () => unknown; footer?: () => unknown }>();
</script>

<template>
  <section class="ui-card" :class="{ interactive, compact, flat, flush }">
    <header v-if="title !== '' || slots.actions" class="head">
      <div class="titles">
        <h3 v-if="title !== ''" class="title">{{ title }}</h3>
        <p v-if="subtitle !== ''" class="subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="slots.actions" class="actions"><slot name="actions" /></div>
    </header>
    <div v-if="slots.default" class="body"><slot /></div>
    <footer v-if="slots.footer" class="foot"><slot name="footer" /></footer>
  </section>
</template>

<style scoped>
.ui-card {
  --card-pad: var(--space-5);
  display: flex; flex-direction: column; min-width: 0; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
  transition: border-color var(--fast) var(--ease), box-shadow var(--medium) var(--ease), transform var(--medium) var(--ease);
}
.compact { --card-pad: var(--space-4); }
.flat { box-shadow: none; background: var(--surface-2); border-color: transparent; }
.interactive { cursor: pointer; }
.interactive:hover { border-color: var(--border-strong); box-shadow: var(--shadow); transform: translateY(-1px); }
.head { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--card-pad) var(--card-pad) 0; }
.head:last-child { padding-bottom: var(--card-pad); }
.titles { flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.subtitle { margin: 2px 0 0; color: var(--text-dim); font-size: var(--text-sm); }
.actions { display: flex; align-items: center; gap: var(--space-1); flex: none; margin: -6px -6px 0 0; }
.body { padding: var(--space-3) var(--card-pad) var(--card-pad); min-width: 0; }
.body:first-child { padding-top: var(--card-pad); }
.flush .body { padding: var(--space-1); }
.foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--card-pad); border-top: 1px solid var(--border); }
</style>
