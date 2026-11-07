<script setup lang="ts">
/**
 * A system asking to pair. With a code, the admin checks the code the system printed matches the one shown here;
 * with a token, it brought one the admin made. It says when the name already belongs to another key (approving
 * replaces that system), and shows the time left draining away.
 */
import type { PairingRequest } from '@harness/core';
import { computed } from 'vue';
import { UiBanner, UiButton, UiIcon } from '../../ui/index.ts';
import { groupedCode, timeLeft } from '../logic/systems.ts';

const props = withDefaults(defineProps<{ pairing: PairingRequest; now: number; busy?: boolean; highlight?: boolean }>(), { busy: false, highlight: false });
const emit = defineEmits<{ approve: []; reject: [] }>();

const span = computed(() => Math.max(1, props.pairing.expiresAt - props.pairing.createdAt));
const left = computed(() => Math.max(0, Math.min(1, (props.pairing.expiresAt - props.now) / span.value)));
</script>

<template>
  <article class="pairing" :class="{ highlight }" :data-testid="`pairing-${pairing.id}`" :aria-label="`${pairing.name} wants to pair`">
    <div class="head">
      <span class="mark" aria-hidden="true"><UiIcon name="link" :size="18" /></span>
      <div class="titles">
        <h3 class="name">{{ pairing.name }} <span class="version">v{{ pairing.version }}</span></h3>
        <p class="meta">From {{ pairing.address }} · key {{ pairing.keyFingerprint }}</p>
      </div>
      <span class="left" :title="`Expires in ${timeLeft(pairing.expiresAt, now)}`">{{ timeLeft(pairing.expiresAt, now) }}</span>
    </div>
    <div v-if="pairing.method === 'code' && pairing.code" class="code-row">
      <span class="hint">Check the system shows this code</span>
      <span class="code" data-testid="pairing-code">{{ groupedCode(pairing.code) }}</span>
    </div>
    <p v-else class="hint">It brought a pairing token you made.</p>
    <UiBanner v-if="pairing.replaces" tone="warn">Approving replaces the system already paired as <strong>{{ pairing.replaces }}</strong>.</UiBanner>
    <div class="actions">
      <UiButton variant="ghost" :disabled="busy" data-testid="pairing-reject" @click="emit('reject')">Reject</UiButton>
      <UiButton variant="primary" icon="check" :loading="busy" data-testid="pairing-approve" @click="emit('approve')">Approve</UiButton>
    </div>
    <span class="drain" :style="{ transform: `scaleX(${left})` }" aria-hidden="true" />
  </article>
</template>

<style scoped>
.pairing {
  position: relative; display: grid; gap: var(--space-3); padding: var(--space-4); overflow: hidden;
  border: 1px solid var(--accent-soft-strong); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm);
  animation: ui-rise-in var(--medium) var(--ease);
}
.pairing.highlight { box-shadow: var(--ring), var(--shadow); }
.head { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.mark { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
.titles { flex: 1; min-width: 0; }
.name { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.version { color: var(--text-faint); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.meta { margin: 2px 0 0; color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
.left { flex: none; color: var(--text-dim); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.code-row {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--surface-2);
}
.hint { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.code { font-family: var(--mono); font-size: var(--text-xl); font-weight: var(--weight-strong); letter-spacing: 0.08em; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.drain { position: absolute; right: 0; bottom: 0; left: 0; height: 3px; background: var(--accent); transform-origin: left; transition: transform var(--slow) linear; }
</style>
