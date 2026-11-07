<script setup lang="ts">
/**
 * A person's or agent's avatar: their picture, or their initials on a soft colour that is always the same for the same
 * name. Agents get a rounded square so they read differently from people. An optional presence dot. Its modifier
 * classes are prefixed (`is-agent`, `is-online`) so a parent's scoped row classes (`.person`) never reach its root.
 */
import { computed, ref, watch } from 'vue';
import UiIcon from './UiIcon.vue';
import { hueOf, initials } from './format.ts';
import type { Presence } from './types.ts';

const props = withDefaults(defineProps<{
  name: string;
  src?: string;
  size?: number;
  kind?: 'person' | 'agent';
  presence?: Presence | undefined;
}>(), { src: '', size: 32, kind: 'person', presence: undefined });

const broken = ref(false);
watch(() => props.src, () => { broken.value = false; });
const hue = computed(() => hueOf(props.name));
</script>

<template>
  <span
    class="ui-avatar" :class="`is-${kind}`" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px`, '--hue': hue }"
    role="img" :aria-label="presence ? `${name}, ${presence}` : name" :title="name"
  >
    <img v-if="src !== '' && !broken" :src="src" alt="" @error="broken = true" />
    <UiIcon v-else-if="kind === 'agent'" name="sparkles" :size="Math.round(size * 0.5)" />
    <span v-else aria-hidden="true">{{ initials(name) }}</span>
    <span v-if="presence" class="presence" :class="`is-${presence}`" aria-hidden="true" />
  </span>
</template>

<style scoped>
.ui-avatar {
  position: relative; display: inline-grid; place-items: center; flex: none; border-radius: 50%;
  background: light-dark(oklch(0.92 0.05 var(--hue)), oklch(0.34 0.06 var(--hue))); color: light-dark(oklch(0.38 0.1 var(--hue)), oklch(0.88 0.08 var(--hue)));
  font-weight: var(--weight-strong); line-height: 1; user-select: none;
}
.is-agent { border-radius: 30%; background: var(--accent-soft-strong); color: var(--accent); }
img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
.presence { position: absolute; right: -1px; bottom: -1px; width: 30%; height: 30%; min-width: 8px; min-height: 8px; border-radius: 50%; box-shadow: 0 0 0 2px var(--surface); }
.is-online { background: var(--ok); }
.is-busy { background: var(--danger); }
.is-away { background: var(--warn); }
.is-offline { background: var(--text-faint); }
</style>
