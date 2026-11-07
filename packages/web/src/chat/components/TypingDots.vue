<script setup lang="ts">
/** Three bouncing dots: the agent (or a person) is writing. Still under reduced motion. */
withDefaults(defineProps<{ label?: string }>(), { label: 'Writing' });
</script>

<template>
  <span class="typing" role="status" :aria-label="label" data-testid="typing-indicator"><span /><span /><span /></span>
</template>

<style scoped>
.typing { display: inline-flex; gap: 4px; padding: var(--space-2) 0; }
.typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); animation: typing 1.2s var(--ease-in-out) infinite; }
.typing span:nth-child(2) { animation-delay: 0.15s; }
.typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes typing { 0%, 60%, 100% { transform: none; opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
</style>
