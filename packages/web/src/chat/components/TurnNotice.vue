<script setup lang="ts">
/**
 * At the foot of the thread when the last turn went wrong: an amber notice with the reason clamped to a few lines
 * behind Show more, and Retry. From the second failure in a row it also suggests a new chat. A fatal stop reads as a
 * terminal banner instead.
 */
import { ref } from 'vue';
import { UiButton, UiIcon } from '../../ui/index.ts';

withDefaults(defineProps<{ reason: string; failures: number; fatal?: boolean }>(), { fatal: false });
const emit = defineEmits<{ retry: []; fresh: [] }>();
const open = ref(false);
</script>

<template>
  <div class="notice" :class="{ fatal }" role="alert" data-testid="turn-failed">
    <UiIcon :name="fatal ? 'error' : 'warning'" :size="18" />
    <div class="text">
      <p class="title">{{ fatal ? 'This turn stopped' : 'The agent couldn\'t finish that' }}</p>
      <p v-if="reason !== ''" class="reason" :class="{ open }">{{ reason }}</p>
      <button v-if="reason.length > 160" type="button" class="more" @click="open = !open">{{ open ? 'Show less' : 'Show more' }}</button>
    </div>
    <div class="actions">
      <UiButton v-if="failures >= 2" size="sm" variant="ghost" @click="emit('fresh')">New chat</UiButton>
      <UiButton size="sm" variant="secondary" icon="refresh" data-testid="retry" @click="emit('retry')">Retry</UiButton>
    </div>
  </div>
</template>

<style scoped>
.notice { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--warn); border-radius: var(--radius-lg); background: var(--warn-soft); color: var(--text); animation: ui-rise-in var(--medium) var(--ease); }
.notice > :first-child { color: var(--warn); flex: none; margin-top: 2px; }
.fatal { border-color: var(--danger); background: var(--danger-soft); }
.fatal > :first-child { color: var(--danger); }
.text { display: grid; gap: 2px; flex: 1 1 240px; min-width: 0; }
.title { margin: 0; font-weight: var(--weight-medium); }
.reason { margin: 0; color: var(--text-dim); font-size: var(--text-sm); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.reason.open { display: block; }
.more { justify-self: start; padding: 0; border: 0; background: transparent; color: var(--text); font-size: var(--text-sm); text-decoration: underline; }
.actions { display: flex; gap: var(--space-2); margin-left: auto; }
</style>
