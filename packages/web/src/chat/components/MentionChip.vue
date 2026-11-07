<script setup lang="ts">
/**
 * A mention as a chip: the friendly label with its type's icon and colour. Hovering (or focusing) asks for its card
 * after a short pause; a tap or click opens the card on touch screens and goes where it leads otherwise.
 */
import { computed } from 'vue';
import { ICONS, UiIcon, hueOf, type IconName } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ label: string; provider: string; icon?: string | undefined; color?: string | undefined }>(), { icon: undefined, color: undefined });
const emit = defineEmits<{ hover: [anchor: HTMLElement]; leave: []; open: [anchor: HTMLElement] }>();

const isIcon = (name: string | undefined): name is IconName => name !== undefined && name in ICONS;
const glyph = computed<IconName>(() => (isIcon(props.icon) ? props.icon : 'link'));
const tint = computed(() => props.color ?? `oklch(0.6 0.12 ${hueOf(props.provider)})`);
let timer: ReturnType<typeof setTimeout> | undefined;

function enter(event: Event): void {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) { return; }
  clearTimeout(timer);
  timer = setTimeout(() => { emit('hover', anchor); }, 250);
}
function leave(): void {
  clearTimeout(timer);
  emit('leave');
}
function open(event: MouseEvent): void {
  const anchor = event.currentTarget;
  if (anchor instanceof HTMLElement) { emit('open', anchor); }
}
</script>

<template>
  <button
    type="button" class="mention-chip touch-target" :style="{ '--chip': tint }" data-testid="mention-chip" :data-provider="provider"
    @mouseenter="enter" @mouseleave="leave" @focus="enter" @blur="leave" @click="open"
  >
    <UiIcon :name="glyph" :size="13" />
    <span class="label">{{ label }}</span>
  </button>
</template>

<style scoped>
.mention-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 24px; padding: 0 8px; margin: 0 1px; vertical-align: baseline;
  border: 1px solid color-mix(in oklch, var(--chip) 35%, transparent); border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--chip) 14%, transparent); color: inherit; font: inherit; font-size: 0.92em; line-height: 1;
  transition: background-color var(--fast) var(--ease);
}
.mention-chip :deep(svg) { color: var(--chip); flex: none; }
.mention-chip:hover { background: color-mix(in oklch, var(--chip) 24%, transparent); }
.mention-chip:focus-visible { outline: none; box-shadow: var(--ring); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
