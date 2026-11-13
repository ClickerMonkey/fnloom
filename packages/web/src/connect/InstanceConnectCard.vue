<script setup lang="ts">
/**
 * Build 9: one instance of an instance-scoped system on its connect page (an MCP server, an API service): its name, how
 * people connect (a sign-in in the browser, a form of the person's own token or header values, or nothing to do),
 * the person's connection with its state, and connecting, reconnecting or disconnecting. A sign-in shared with
 * everyone is made once by an admin; others see it as shared.
 */
import type { GinTypeDef, Json } from '@harness/core';
import GinForm from '../gin/GinForm.vue';
import { UiBadge, UiButton, UiIcon } from '../ui/index.ts';
import { STATUS_WORDS, type InstanceCard } from './logic.ts';

const props = withDefaults(defineProps<{ card: InstanceCard; busy?: boolean; /** People's names by id (who shared a sign-in). */ owners?: Readonly<Record<string, string>> }>(), { busy: false, owners: () => ({}) });
const emit = defineEmits<{ connect: [form?: Json]; disconnect: [] }>();

const connected = (): boolean => props.card.own?.status === 'connected';
const form = (): GinTypeDef | undefined => (props.card.connect.flow?.flow === 'form' ? props.card.connect.flow.form : undefined);
</script>

<template>
  <li class="card" :data-instance="card.instance" data-testid="instance-connect">
    <div class="row">
      <span class="mark" aria-hidden="true"><UiIcon :name="card.flow === 'none' ? 'check' : 'key'" :size="16" /></span>
      <div class="who">
        <span class="label">{{ card.label }}</span>
        <span class="detail">
          <template v-if="card.own !== undefined">
            <UiBadge :tone="STATUS_WORDS[card.own.status].tone" dot>{{ STATUS_WORDS[card.own.status].label }}</UiBadge>
            <span v-if="card.own.account">{{ card.own.account.label }}</span>
          </template>
          <span v-else-if="card.flow === 'none'">Ready: no sign-in needed.</span>
          <span v-else-if="card.shared.length > 0">Shared by {{ owners[card.shared[0]?.owner ?? ''] ?? 'someone' }}</span>
          <span v-else-if="!card.mayConnect">An admin signs in once for everyone.</span>
          <span v-else>{{ card.connect.title }}</span>
        </span>
      </div>
      <div class="actions">
        <UiButton
          v-if="card.mayConnect && card.flow === 'oauth' && !connected()" variant="primary" icon="link" size="sm" :loading="busy"
          data-testid="instance-connect-start" @click="emit('connect')"
        >
          {{ card.own === undefined ? 'Sign in' : 'Sign in again' }}
        </UiButton>
        <UiButton v-if="card.own !== undefined" variant="ghost" icon="x" size="sm" :loading="busy" data-testid="instance-disconnect" @click="emit('disconnect')">Disconnect</UiButton>
      </div>
    </div>
    <p v-if="card.own?.problem" class="problem">{{ card.own.problem }}</p>
    <GinForm
      v-if="card.mayConnect && form() !== undefined && !connected()" :type="form()" submit-label="Connect" :busy="busy" :cancellable="false"
      :label="card.connect.title" @submit="emit('connect', $event)"
    />
  </li>
</template>

<style scoped>
.card { display: grid; gap: var(--space-3); padding: var(--space-3) var(--space-4); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.mark { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: var(--radius); background: var(--surface-2); color: var(--accent); flex: none; }
.who { display: grid; gap: 2px; flex: 1 1 12rem; min-width: 0; }
.label { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.detail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-sm); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
