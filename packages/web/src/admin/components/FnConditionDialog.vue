<script setup lang="ts">
/**
 * The condition of one fn rule (`FnMatch.when`): a gin predicate over the fn's args, made and changed with gin's
 * expression editor, its value type and problems shown as it is edited. A rule without one starts from `true`;
 * Remove drops it, so the rule matches by name, tags, system and kind alone. Save emits the condition as JSON.
 */
import { GinExprDef, Json, type FnMatch } from '@harness/core';
import { g } from '@harness/sdk';
import { computed, ref, shallowRef, watch } from 'vue';
import GinExprView from '../../gin/GinExprView.vue';
import { UiBanner, UiButton, UiDialog } from '../../ui/index.ts';

const props = defineProps<{ match: FnMatch | undefined; title: string }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [when: GinExprDef | undefined] }>();

/** What a condition may read: the fn's args (any shape, since a rule can match many fns). */
const SCOPE = { args: g.any().toJSON() } as const;
/** Where a new condition starts: always true, to be narrowed. */
const STARTING: GinExprDef = { kind: 'new', type: g.bool().toJSON(), value: true };

const draft = shallowRef<GinExprDef | undefined>(undefined);
const problem = ref('');
watch(open, (isOpen) => {
  if (!isOpen) { return; }
  problem.value = '';
  const when = props.match?.when;
  if (when === undefined) { draft.value = undefined; return; }
  const parsed = GinExprDef.safeParse(when);
  draft.value = parsed.success ? parsed.data : undefined;
  if (!parsed.success) { problem.value = 'This condition isn’t a gin expression the editor can read; saving a new one replaces it.'; }
}, { immediate: true });
const had = computed(() => props.match?.when !== undefined);

function save(): void {
  if (draft.value === undefined) { emit('save', undefined); return; }
  const json = Json.safeParse(draft.value);
  if (!json.success) { problem.value = 'This condition can’t be saved as JSON.'; return; }
  emit('save', draft.value);
}
</script>

<template>
  <UiDialog v-model:open="open" :title="title" description="A gin predicate over the fn's args: the rule matches a call only when it gives true." width="640px">
    <div class="body" data-testid="fn-condition">
      <UiBanner v-if="problem !== ''" tone="warn">{{ problem }}</UiBanner>
      <GinExprView v-if="draft" v-model="draft" :scope="SCOPE" label="Condition" data-testid="fn-condition-expr" />
      <div v-else class="none">
        <p class="dim">No condition: the rule matches by name, tags, system and kind alone.</p>
        <UiButton size="sm" icon="plus" data-testid="fn-condition-start" @click="draft = STARTING">Add a condition</UiButton>
      </div>
    </div>
    <template #footer>
      <UiButton v-if="draft" variant="ghost" icon="trash" data-testid="fn-condition-remove" @click="draft = undefined">Remove the condition</UiButton>
      <span class="grow" />
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :disabled="!had && draft === undefined" data-testid="fn-condition-save" @click="save">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.body { display: grid; gap: var(--space-3); min-width: 0; }
.none { display: grid; justify-items: start; gap: var(--space-2); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.grow { flex: 1; }
</style>
