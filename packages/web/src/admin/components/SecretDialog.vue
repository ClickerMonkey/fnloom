<script setup lang="ts">
/**
 * A secret shown once (a new hub MCP's, or a rotated one): hidden until revealed, copyable, with the plain warning
 * that it won't be shown again. Closing it asks nothing: the hub keeps only its digest.
 */
import { ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiIconButton, copyText } from '../../ui/index.ts';

const props = defineProps<{ secret: string; title: string }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ copied: [] }>();
const shown = ref(false);
watch(() => props.secret, () => { shown.value = false; });

async function copy(): Promise<void> {
  if (await copyText(props.secret)) { emit('copied'); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="title" description="Give it to the MCP client. The hub keeps only a fingerprint of it." width="520px">
    <div class="secret" data-testid="secret-dialog">
      <div class="value">
        <code data-testid="secret-value">{{ shown ? secret : '•'.repeat(Math.min(32, secret.length)) }}</code>
        <UiIconButton :icon="shown ? 'x' : 'eye'" :label="shown ? 'Hide' : 'Reveal'" data-testid="secret-reveal" @click="shown = !shown" />
        <UiIconButton icon="copy" label="Copy" data-testid="secret-copy" @click="copy" />
      </div>
      <UiBanner tone="warn">This is the only time it is shown. If it is lost, rotate the secret to make a new one.</UiBanner>
    </div>
    <template #footer>
      <UiButton variant="primary" data-testid="secret-done" @click="open = false">I've saved it</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.secret { display: grid; gap: var(--space-3); }
.value { display: flex; align-items: center; gap: var(--space-1); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--code-bg); }
.value code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: var(--text-sm); }
</style>
