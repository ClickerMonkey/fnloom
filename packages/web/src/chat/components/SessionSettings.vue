<script setup lang="ts">
/**
 * A chat's settings: how you hear about it (every message, replies to you, nothing), which systems it uses (each
 * with its status), and who is in it. Changes save as they are made.
 */
import type { ChatCapabilities, NotifyChoice, Session, SystemName } from '@harness/core';
import { computed } from 'vue';
import { UiAvatar, UiBadge, UiSegmented, UiSwitch, type SegmentOption } from '../../ui/index.ts';

const props = defineProps<{
  session: Session;
  systems: ChatCapabilities['systems'];
  notify: NotifyChoice;
  agent: string;
  /** A person's or agent's name. */
  nameOf: (actor: Session['participants'][number]) => string;
}>();
const emit = defineEmits<{ notify: [choice: NotifyChoice]; systems: [systems: SystemName[] | 'all'] }>();

const NOTIFY: readonly SegmentOption<NotifyChoice>[] = [{ value: 'all', label: 'Every message' }, { value: 'replies', label: 'Replies to me' }, { value: 'none', label: 'Nothing' }];

const enabled = computed(() => new Set(props.session.systems === 'all' ? props.systems.map((s) => s.name) : props.session.systems));

function toggle(name: SystemName, on: boolean): void {
  const next = props.systems.map((s) => s.name).filter((n) => (n === name ? on : enabled.value.has(n)));
  emit('systems', next.length === props.systems.length ? 'all' : next);
}
</script>

<template>
  <div class="settings" data-testid="session-settings">
    <section class="section">
      <h3 class="heading">Agent</h3>
      <p class="dim">{{ agent }} answers in this chat.</p>
    </section>
    <section class="section">
      <h3 class="heading">Notify me about</h3>
      <UiSegmented :model-value="notify" :options="NOTIFY" label="Notify me about" @update:model-value="emit('notify', $event)" />
    </section>
    <section class="section">
      <h3 class="heading">Systems</h3>
      <p class="dim">Only these systems’ fns, context, mentions and hooks apply here.</p>
      <ul class="systems">
        <li v-for="system in systems" :key="system.name" class="system" :data-system="system.name">
          <UiSwitch :model-value="enabled.has(system.name)" :label="system.name" :disabled="!system.enabled" @update:model-value="toggle(system.name, $event)" />
          <UiBadge :tone="system.status === 'connected' ? 'ok' : system.status === 'needs-config' ? 'warn' : 'neutral'">{{ system.status }}</UiBadge>
        </li>
        <li v-if="systems.length === 0" class="dim">No systems are connected.</li>
      </ul>
    </section>
    <section class="section">
      <h3 class="heading">People</h3>
      <ul class="people" data-testid="people">
        <li v-for="p in session.participants" :key="p.actor" class="person">
          <UiAvatar :name="nameOf(p)" :kind="p.role === 'agent' ? 'agent' : 'person'" :size="28" />
          <span class="name">{{ nameOf(p) }}</span>
          <span class="role">{{ p.role }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.settings { display: grid; gap: var(--space-5); min-width: 0; }
.section { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.systems, .people { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.system { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.person { display: flex; align-items: center; gap: var(--space-3); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role { color: var(--text-faint); font-size: var(--text-xs); }
</style>
