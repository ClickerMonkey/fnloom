<script setup lang="ts">
/** A status as a small badge: its word, its tone, and a dot that breathes while it is in motion. */
import { UiBadge } from '../../ui/index.ts';
import type { StatusLook } from '../logic/systems.ts';

defineProps<{ look: StatusLook }>();
</script>

<template>
  <UiBadge :tone="look.tone" dot :live="look.live" data-testid="status">{{ look.word }}</UiBadge>
</template>
