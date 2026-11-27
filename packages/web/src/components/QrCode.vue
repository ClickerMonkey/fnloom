<script setup lang="ts">
/**
 * A QR code of a link, for a phone's camera: drawn as a picture by `qrcode` (loaded when first shown), with the link
 * written under it for anyone typing it in.
 */
import { shallowRef, watch } from 'vue';

const props = withDefaults(defineProps<{
  /** What the code says. */
  text: string;
  /** What it is, for screen readers. */
  label: string;
  size?: number;
}>(), { size: 148 });

const src = shallowRef('');
watch(() => props.text, async (text) => {
  const { toString } = await import('qrcode');
  const svg = await toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  // a later link may have arrived meanwhile
  if (text === props.text) { src.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; }
}, { immediate: true });
</script>

<template>
  <figure class="qr">
    <img v-if="src !== ''" :src="src" :width="size" :height="size" :alt="label" data-testid="qr-code" />
    <figcaption class="text">{{ text }}</figcaption>
  </figure>
</template>

<style scoped>
.qr { display: grid; justify-items: center; gap: var(--space-2); margin: 0; }
img { border-radius: var(--radius); background: #fff; }
.text { max-width: 100%; color: var(--text-dim); font-family: var(--font-mono, monospace); font-size: var(--text-xs); overflow-wrap: anywhere; text-align: center; }
</style>
