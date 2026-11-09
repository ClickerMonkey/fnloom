<script setup lang="ts">
/**
 * Making a hub MCP, or changing its settings: its name (the route follows it until edited), route, instructions sent
 * to clients, how fns are offered, whose permissions its runs use, the systems that may mint session tokens for it
 * (picked), the browser origins allowed (typed), and whether it is on. Rules are edited on its page; a new MCP starts exposing nothing.
 */
import type { ActorId, HubMcpInput, HubMcpView, McpToolMode } from '@harness/core';
import { HubMcpInput as McpInput } from '@harness/core';
import { computed, ref, watch } from 'vue';
import HubPicker from '../../components/pickers/HubPicker.vue';
import { UiBanner, UiButton, UiChipInput, UiDialog, UiInput, UiSegmented, UiSelect, UiSwitch, UiTextarea, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { emptyRules, slugOf, TOOL_MODE_WORDS } from '../logic/mcps.ts';

const props = withDefaults(defineProps<{
  /** The MCP being changed; absent to make one. */
  mcp?: HubMcpView | undefined;
  /** The people whose permissions its runs may use. */
  people: readonly { readonly id: ActorId; readonly name: string }[];
  /** Who is signed in (the default person for a new MCP). */
  me: ActorId | undefined;
  busy?: boolean;
  problem?: string;
}>(), { mcp: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [input: HubMcpInput] }>();

const name = ref('');
const slug = ref('');
const slugEdited = ref(false);
const instructions = ref('');
const toolMode = ref<McpToolMode>('each');
/** The person its runs use ('' until one is chosen). */
const user = ref<ActorId>('');
const grantees = ref<readonly string[]>([]);
const origins = ref<readonly string[]>([]);
const enabled = ref(true);
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  const m = props.mcp;
  name.value = m?.name ?? '';
  slug.value = m?.slug ?? '';
  slugEdited.value = m !== undefined;
  instructions.value = m?.instructions ?? '';
  toolMode.value = m?.toolMode ?? 'each';
  user.value = m?.user ?? props.me ?? '';
  grantees.value = m?.grantees ?? [];
  origins.value = m?.origins ?? [];
  enabled.value = m?.enabled ?? true;
  tried.value = false;
}, { immediate: true });
watch(name, (value) => { if (!slugEdited.value) { slug.value = slugOf(value) ?? ''; } });

const MODES: readonly SegmentOption<McpToolMode>[] = (['each', 'static'] as const).map((mode) => ({ value: mode, label: TOOL_MODE_WORDS[mode].label }));
const people = computed<SelectOption<ActorId>[]>(() => [{ value: '', label: 'Choose a person' }, ...props.people.map((p) => ({ value: p.id, label: p.name }))]);
const readOrigin = (text: string): string | undefined => (text === '' ? undefined : text);

/** The input the fields make, checked with the hub's own schema. */
const checked = computed(() => McpInput.safeParse({
  name: name.value.trim(), slug: slug.value.trim(), instructions: instructions.value.trim(), toolMode: toolMode.value, user: user.value,
  grantees: grantees.value, origins: origins.value, enabled: enabled.value, rules: props.mcp?.rules ?? emptyRules(),
}));
const problemOf = (field: keyof HubMcpInput): string => {
  if (!tried.value || checked.value.success) { return ''; }
  const issue = checked.value.error.issues.find((i) => i.path[0] === field);
  return issue === undefined ? '' : issue.message;
};

function save(): void {
  tried.value = true;
  if (checked.value.success) { emit('save', checked.value.data); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="mcp ? `Settings of ${mcp.name}` : 'New MCP'" :description="mcp ? '' : 'An MCP endpoint into the hub, with its own route, secret and rules.'" width="560px">
    <form class="form" novalidate data-testid="mcp-form" @submit.prevent="save">
      <UiInput v-model="name" label="Name" placeholder="Claude sessions" required :error="problemOf('name')" data-testid="mcp-name" />
      <UiInput
        :model-value="slug" label="Route" :hint="`/mcp/${slug || '…'}`" required :error="problemOf('slug') ? 'Lowercase letters, digits and dashes, starting with a letter.' : ''"
        data-testid="mcp-slug" @update:model-value="slug = $event; slugEdited = true"
      />
      <UiTextarea v-model="instructions" label="Instructions" :rows="2" placeholder="What clients should know about it" hint="Sent to every client when it connects." />
      <div class="field">
        <span class="label">Tools</span>
        <UiSegmented v-model="toolMode" :options="MODES" label="Tools" data-testid="mcp-tool-mode" />
        <p class="hint">{{ TOOL_MODE_WORDS[toolMode].about }}</p>
      </div>
      <UiSelect v-model="user" :options="people" label="Runs as" hint="Its runs use this person's permissions, budgets and approvals." required :error="problemOf('user')" data-testid="mcp-user" />
      <HubPicker
        v-model="grantees" source="system" label="Systems that may mint session tokens" placeholder="Search systems" hint="A grantee's runs get short-lived tokens for their own sessions."
        :error="problemOf('grantees')" testid="mcp-grantees"
      />
      <UiChipInput v-model="origins" label="Browser origins" placeholder="https://claude.ai" hint="Enter adds one. None allows only requests with no Origin header." :read="readOrigin" refusal="Type an origin." />
      <UiSwitch v-model="enabled" label="On" description="Off refuses every call and keeps its settings." />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
      <!-- Enter in a field submits the form; the visible button is in the footer, outside it -->
      <button type="submit" hidden />
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="mcp-save" @click="save">{{ mcp ? 'Save' : 'Make it' }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
