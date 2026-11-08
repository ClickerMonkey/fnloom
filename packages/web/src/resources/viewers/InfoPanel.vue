<script setup lang="ts">
/**
 * What is known about a resource: its type, format and size, its address, when it changed and was seen, where it
 * came from, its version, the forms made of it (with what made each and its size in tokens), and its links (each
 * opens the resource it points at, when it is one).
 */
import type { FormRecord, ResourceLink, ResourceRecord, ResourceStat } from '@harness/core';
import { computed } from 'vue';
import { UiBadge, fullTime } from '../../ui/index.ts';
import { formatBytes } from '../../chat/logic/format.ts';
import { FAMILY_LABEL, FORM_LABEL, familyOfStat } from '../logic/formats.ts';

const props = defineProps<{ stat: ResourceStat; record: ResourceRecord | undefined; forms: readonly FormRecord[]; links: readonly ResourceLink[] }>();
const emit = defineEmits<{ open: [uri: string] }>();

const source = computed(() => {
  const from = props.record?.source;
  if (from === undefined) { return props.record === undefined ? 'Its system' : `The ${props.record.system} system`; }
  switch (from.from) {
    case 'system': return `The ${from.system} system`;
    case 'upload': return 'An upload';
    case 'web': return `The web: ${from.finalUrl ?? from.url}${from.rendered ? ' (rendered)' : ''}`;
    case 'run': return `A run of ${from.fn}`;
  }
});
const facts = computed(() => [
  ['Type', `${FAMILY_LABEL[familyOfStat(props.stat)]}${props.stat.format === undefined ? '' : ` · ${props.stat.format}`}`],
  ['Media type', props.stat.mime ?? ''],
  ['Size', props.stat.size === undefined ? '' : formatBytes(props.stat.size)],
  ['Address', props.stat.uri],
  ['Changed', props.stat.modifiedAt === undefined ? '' : fullTime(props.stat.modifiedAt)],
  ['Seen', props.record === undefined ? '' : fullTime(props.record.seenAt)],
  ['From', source.value],
  ['Version', props.stat.version],
  ['Indexed', props.record?.indexedVersion === undefined ? 'Not yet' : props.record.indexedVersion === props.stat.version ? 'Yes' : 'An older version'],
].filter(([, value]) => value !== ''));
</script>

<template>
  <div class="info-panel" data-testid="resource-info">
    <dl class="facts">
      <div v-for="[label, value] in facts" :key="label" class="fact"><dt>{{ label }}</dt><dd>{{ value }}</dd></div>
    </dl>
    <section v-if="forms.length > 0" class="section">
      <h3 class="heading">Forms</h3>
      <ul class="list">
        <li v-for="form in forms" :key="`${form.kind}:${form.converter}`" class="form">
          <UiBadge :tone="form.kind === record?.primary ? 'accent' : 'neutral'">{{ FORM_LABEL[form.kind] }}</UiBadge>
          <span class="dim">{{ form.tokens.toLocaleString() }} tokens · {{ form.converter }}</span>
          <span v-if="form.kind === record?.primary" class="dim">read by default</span>
        </li>
      </ul>
    </section>
    <section v-if="links.length > 0" class="section">
      <h3 class="heading">Links</h3>
      <ul class="list">
        <li v-for="(link, i) in links.slice(0, 100)" :key="i" class="link">
          <button v-if="link.uri" type="button" class="open" @click="emit('open', link.uri)">{{ link.title ?? link.raw }}</button>
          <code v-else>{{ link.title ?? link.raw }}</code>
          <span class="dim">{{ link.kind }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.info-panel { display: grid; gap: var(--space-4); min-width: 0; }
.facts { display: grid; gap: var(--space-2); margin: 0; }
.fact { display: grid; grid-template-columns: minmax(90px, 30%) minmax(0, 1fr); gap: var(--space-3); }
.fact dt { color: var(--text-faint); font-size: var(--text-xs); }
.fact dd { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.section { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-dim); }
.list { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.form, .link { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-sm); }
.open { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.open:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 4px; }
.dim { color: var(--text-faint); font-size: var(--text-xs); }
</style>
