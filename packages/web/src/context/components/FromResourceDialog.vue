<script setup lang="ts">
/**
 * Making context from a resource: the resource, found by words (the hub's resource search) or by its address, whether the items read the resource's current text when loaded
 * (`live`, never stale) or keep a copy (`snapshot`, marked stale when the resource changes), and an optional
 * `/command` that loads it. The hub makes one item for the resource and one per section, linked in order; making it
 * again updates the same items. Save sends the checked arguments.
 */
import { HUB_RESOURCE_ROOT, type ContextCopy, type ContextFromResourceArgs, type ResourceRecord } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { FAMILY_ICON, familyOfStat } from '../../resources/logic/formats.ts';
import { nameOf, shortAddress } from '../../resources/logic/browse.ts';
import { UiBanner, UiButton, UiDialog, UiIcon, UiInput, UiSegmented, UiSpinner, type SegmentOption } from '../../ui/index.ts';
import { fromResourceRequest } from '../logic/context.ts';

const props = withDefaults(defineProps<{
  uri?: string;
  busy?: boolean;
  problem?: string;
  /** The resources matching the last `find`. */
  found?: readonly ResourceRecord[];
  /** Whether a `find` is on its way. */
  finding?: boolean;
  /** Why the last `find` failed; '' when it worked. */
  findProblem?: string;
}>(), { uri: '', busy: false, problem: '', found: () => [], finding: false, findProblem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [args: ContextFromResourceArgs]; find: [text: string] }>();

/** An address of the form the hub's own resources have, as the address field's example. */
const EXAMPLE_ADDRESS = `${HUB_RESOURCE_ROOT}uploads/notes.md`;
/** How long typing pauses before the words are searched. */
const FIND_PAUSE = 250;

const COPIES: readonly SegmentOption<ContextCopy>[] = [{ value: 'live', label: 'Live', icon: 'refresh' }, { value: 'snapshot', label: 'Snapshot', icon: 'copy' }];
const COPY_ABOUT = {
  live: 'Reads the resource’s current text whenever it is loaded, so it is never stale.',
  snapshot: 'Keeps a copy of the text now, marked stale when the resource changes.',
} as const satisfies Record<ContextCopy, string>;

const address = ref('');
const words = ref('');
let findTimer: ReturnType<typeof setTimeout> | undefined;
watch(words, (text) => { clearTimeout(findTimer); findTimer = setTimeout(() => { emit('find', text); }, FIND_PAUSE); });
onBeforeUnmount(() => { clearTimeout(findTimer); });
/** The matches to offer: none until words are typed. */
const matches = computed(() => (words.value.trim() === '' ? [] : props.found));
function choose(record: ResourceRecord): void {
  address.value = record.uri;
}
const copyMode = ref<ContextCopy>('live');
const command = ref('');
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  address.value = props.uri; words.value = ''; copyMode.value = 'live'; command.value = ''; tried.value = false;
}, { immediate: true });

const copyAbout = computed(() => COPY_ABOUT[copyMode.value]);
const checked = computed(() => fromResourceRequest({ uri: address.value, copy: copyMode.value, command: command.value }));
const error = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Make context from a resource" description="One item for the resource and one for each of its sections, linked in order." width="520px">
    <form class="form" data-testid="from-resource-form" @submit.prevent="save">
      <div class="find">
        <UiInput v-model="words" type="search" icon="search" label="Find a resource" placeholder="Search names, addresses and contents" clearable autofocus data-testid="from-resource-find" />
        <UiSpinner v-if="finding" class="finding" :size="16" label="Searching" />
        <p v-if="findProblem !== ''" class="find-problem" role="alert">{{ findProblem }}</p>
        <ul v-else-if="matches.length > 0" class="found" aria-label="Matching resources" data-testid="from-resource-found">
          <li v-for="record in matches" :key="record.uri">
            <button type="button" class="match" :aria-pressed="address === record.uri" :data-uri="record.uri" @click="choose(record)">
              <UiIcon :name="FAMILY_ICON[familyOfStat(record.stat)]" :size="16" />
              <span class="match-text">
                <span class="match-name">{{ nameOf(record) }}</span>
                <span class="match-uri" :title="record.uri">{{ shortAddress(record.uri) }}</span>
              </span>
              <UiIcon v-if="address === record.uri" class="check" name="check" :size="16" />
            </button>
          </li>
        </ul>
        <p v-else-if="words.trim() !== '' && !finding" class="hint">No resources match.</p>
      </div>
      <UiInput v-model="address" label="Resource address" :placeholder="EXAMPLE_ADDRESS" hint="Filled in by choosing a resource above, or paste one." :error="error" data-testid="from-resource-uri" />
      <div class="field">
        <span class="label">Text</span>
        <UiSegmented v-model="copyMode" :options="COPIES" label="Text" />
        <p class="hint">{{ copyAbout }}</p>
      </div>
      <UiInput v-model="command" label="Command" placeholder="readme" hint="Optional: typing /readme in a chat loads it." />
      <UiBanner v-if="problem !== ''" tone="danger" icon="warning">{{ problem }}</UiBanner>
      <button type="submit" hidden />
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" icon="sparkles" :loading="busy" data-testid="from-resource-save" @click="save">Make context</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
.find { position: relative; display: grid; gap: var(--space-2); min-width: 0; }
.finding { position: absolute; top: 2px; right: 0; }
.find-problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.found { display: grid; gap: 2px; max-height: 240px; margin: 0; padding: 2px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); list-style: none; }
.match {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); width: 100%; padding: var(--space-2);
  border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--text); text-align: left;
}
.match:hover { background: var(--surface-2); }
.match[aria-pressed='true'] { border-color: var(--accent-soft-strong); background: var(--accent-soft); }
.match:focus-visible { outline: none; box-shadow: var(--ring); }
.match-text { display: grid; min-width: 0; }
.match-name { overflow: hidden; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.match-uri { overflow: hidden; color: var(--text-faint); font-family: var(--mono); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.check { color: var(--accent); }
</style>
