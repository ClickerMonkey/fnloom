<script setup lang="ts">
/**
 * A system's instances (a fleet: one attached copy per machine, `fs@laptop`): each with what it said about itself,
 * its status, version, address, when it was last seen and whether the hub runs it, and the default instance marked.
 * Each opens its own page.
 */
import type { InstanceName, InstanceView } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import { UiBadge, UiIcon, fullTime, relativeTime } from '../../ui/index.ts';
import { INSTALLED_STATUS_LOOK, SYSTEM_STATUS_LOOK } from '../logic/systems.ts';
import StatusBadge from './StatusBadge.vue';

withDefaults(defineProps<{
  instances: readonly InstanceView[];
  now: number;
  pageOf: (instance: InstanceName) => RouteLocationRaw;
  /** The instance runs go to when nothing else picks one. */
  defaultInstance?: InstanceName | undefined;
}>(), { defaultInstance: undefined });
</script>

<template>
  <ul class="instances" data-testid="instances">
    <li v-for="item in instances" :key="item.instance" class="instance" :data-instance="item.instance">
      <RouterLink class="open" :to="pageOf(item.instance)" data-testid="instance-row">
        <span class="mark" aria-hidden="true"><UiIcon name="server" :size="16" /></span>
        <span class="main">
          <span class="top">
            <span class="name">{{ item.system }}@{{ item.instance }}</span>
            <StatusBadge :look="SYSTEM_STATUS_LOOK[item.status]" />
            <UiBadge v-if="defaultInstance === item.instance" tone="accent">Default</UiBadge>
            <StatusBadge v-if="item.installed" :look="INSTALLED_STATUS_LOOK[item.installed.status]" />
          </span>
          <span v-if="item.description !== ''" class="detail">{{ item.description }}</span>
          <span class="facts">
            v{{ item.version }}<template v-if="item.address"> · {{ item.address }}</template>
            <template v-if="item.lastSeenAt !== undefined"> · <time :title="fullTime(item.lastSeenAt)">{{ item.status === 'connected' ? 'online now' : `seen ${relativeTime(item.lastSeenAt, now)}` }}</time></template>
            <template v-if="item.config === undefined"> · no config yet</template>
          </span>
        </span>
        <UiIcon name="chevron-right" :size="16" class="chevron" />
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
.instances { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.instance + .instance { border-top: 1px solid var(--border); }
.open { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none; }
.open:hover { background: var(--surface-2); text-decoration: none; }
.open:focus-visible { outline: none; box-shadow: inset var(--ring); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.detail { color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.facts { color: var(--text-faint); font-size: var(--text-xs); overflow-wrap: anywhere; }
.chevron { color: var(--text-faint); }
</style>
