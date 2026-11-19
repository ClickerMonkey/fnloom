<script setup lang="ts">
/**
 * Setting up an A/B compare of the message being written: 2 to 4 variants side by side (stacked on a phone), each
 * changing any of the chat's settings, the system prompt too. Each variant is reserved an even share of this
 * message's budget up front, which the dialog says; writes a variant wants to make are asked about in that variant.
 */
import type { ChatCapabilities, CompareSettings, CompareVariantInput, Session } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiButton, UiIcon, UiModal } from '../../ui/index.ts';
import { addDraft, MAX_VARIANTS, MIN_VARIANTS, removeDraft, repeatedDraft, startingDrafts, variantInputs, type VariantDraft } from '../logic/compare.ts';
import { formatCost } from '../logic/format.ts';
import VariantSettings from './VariantSettings.vue';

const props = withDefaults(defineProps<{
  session: Pick<Session, keyof CompareSettings>;
  models: ChatCapabilities['models'];
  agents: ChatCapabilities['agents'];
  systems: ChatCapabilities['systems'];
  /** The message being compared, as the person wrote it. */
  draft: string;
  /** This message's budget, which the variants share. */
  budget?: number | undefined;
  busy?: boolean;
  phone?: boolean;
}>(), { budget: undefined, busy: false, phone: false });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ start: [variants: CompareVariantInput[]] }>();

const drafts = ref<VariantDraft[]>(startingDrafts());
// each time it opens it starts fresh: the chat as it is, and one to change
watch(open, (now) => { if (now) { drafts.value = startingDrafts(); } });

const repeated = computed(() => repeatedDraft(drafts.value));
const share = computed(() => (props.budget === undefined ? undefined : props.budget / drafts.value.length));
const ready = computed(() => repeated.value === undefined && props.draft.trim() !== '');

function update(index: number, draft: VariantDraft): void {
  drafts.value = drafts.value.map((d, at) => (at === index ? draft : d));
}

function start(): void {
  if (ready.value) { emit('start', variantInputs(drafts.value)); }
}
</script>

<template>
  <UiModal v-model:open="open" :placement="phone ? 'bottom' : 'center'" width="min(1180px, 96vw)" label="Compare answers" data-testid="compare-dialog">
    <header class="top">
      <div class="title">
        <UiIcon name="columns" :size="18" />
        <h2>Compare answers</h2>
      </div>
      <p class="quote" :title="draft">“{{ draft.trim() === '' ? 'Write the message to compare first.' : draft }}”</p>
    </header>
    <div class="body">
      <div class="grid" :style="{ '--n': drafts.length }">
        <VariantSettings
          v-for="(item, index) in drafts" :key="index" :index="index" :draft="item" :session="session" :models="models" :agents="agents" :systems="systems"
          :removable="drafts.length > MIN_VARIANTS" :repeated="repeated === index" @update="update(index, $event)" @remove="drafts = removeDraft(drafts, index)"
        />
        <button v-if="drafts.length < MAX_VARIANTS" type="button" class="add" data-testid="variant-add" @click="drafts = addDraft(drafts)">
          <UiIcon name="plus" :size="18" /><span>Add a variant</span><span class="dim">up to {{ MAX_VARIANTS }}</span>
        </button>
      </div>
    </div>
    <footer class="foot">
      <p class="note">
        <UiIcon name="coins" :size="14" />
        <span v-if="share !== undefined">Each answer gets {{ formatCost(share) }}, a {{ drafts.length === 2 ? 'half' : `1/${drafts.length}` }} of this message’s budget.</span>
        <span v-else>Each answer gets an even share of this message’s budget.</span>
        <span class="dim">Changes they want to make are asked about in each one. Nothing joins the chat until you choose.</span>
      </p>
      <div class="buttons">
        <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
        <UiButton variant="primary" icon="columns" :disabled="!ready" :loading="busy" data-testid="compare-start" @click="start">Compare {{ drafts.length }} answers</UiButton>
      </div>
    </footer>
  </UiModal>
</template>

<style scoped>
.top { display: grid; gap: var(--space-1); padding: var(--space-4) var(--space-4) var(--space-2); border-bottom: 1px solid var(--border); }
.title { display: flex; align-items: center; gap: var(--space-2); color: var(--accent); }
h2 { margin: 0; font-size: var(--text-lg); color: var(--text); }
.quote { margin: 0; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.body { flex: 1; min-height: 0; overflow: auto; padding: var(--space-4); }
.grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); }
.add {
  display: grid; place-items: center; align-content: center; gap: var(--space-1); min-height: 160px; padding: var(--space-4); border: 1px dashed var(--border);
  border-radius: var(--radius-lg); background: transparent; color: var(--text-dim); font: inherit; cursor: pointer;
  transition: border-color var(--fast) var(--ease), color var(--fast) var(--ease), background-color var(--fast) var(--ease);
}
.add:hover { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.dim { color: var(--text-faint); font-size: var(--text-sm); }
.foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4) max(var(--space-3), var(--safe-bottom));
  border-top: 1px solid var(--border);
}
.note { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); margin: 0; font-size: var(--text-sm); flex: 1 1 320px; }
.buttons { display: flex; gap: var(--space-2); margin-left: auto; }
</style>
