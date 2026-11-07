<script setup lang="ts">
/** Who is in a chat: each person and agent with their avatar, name and role. */
import type { Session } from '@harness/core';
import { UiAvatar } from '../../ui/index.ts';
import { humanize } from '../logic/labels.ts';

defineProps<{
  participants: Session['participants'];
  /** A person's or agent's name. */
  nameOf: (actor: Session['participants'][number]) => string;
}>();
</script>

<template>
  <ul class="people" data-testid="people">
    <li v-for="p in participants" :key="p.actor" class="member">
      <UiAvatar :name="nameOf(p)" :kind="p.role === 'agent' ? 'agent' : 'person'" :size="28" />
      <span class="name">{{ nameOf(p) }}</span>
      <span class="role">{{ humanize(p.role) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.people { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.member { display: flex; align-items: center; gap: var(--space-3); min-height: 36px; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role { color: var(--text-faint); font-size: var(--text-xs); }
</style>
