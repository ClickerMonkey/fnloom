<script setup lang="ts">
/**
 * The form an approval asks the approver to fill (`Approval.ask`, build 9): a question Claude waits on, an MCP
 * server's elicitation. Drawn with the gin inputs for the asked type; each change emits the value when it checks out,
 * else undefined, so the card's Approve waits for a value that fits. Problems show under each field once the person
 * has started.
 */
import type { Json, ProposalAsk } from '@harness/core';
import { inject, shallowRef, watch } from 'vue';
import GinInput from '../../gin/components/GinInput.vue';
import { FormState } from '../../gin/state.ts';
import { GIN_TYPES, LOCAL_TYPES } from '../../gin/types.ts';
import type { Draft } from '../../gin/logic/form.ts';

const props = withDefaults(defineProps<{
  /** The gin type asked for. */
  type: ProposalAsk['type'];
  /** Changes when another approval takes the card, which starts the form again. */
  ident?: string;
  /** What the card calls the form (`ProposalAsk.label`), such as a choice's words. */
  label?: string | undefined;
}>(), { ident: '', label: undefined });
const emit = defineEmits<{ change: [value: Json | undefined] }>();

const types = inject(GIN_TYPES, LOCAL_TYPES);
const form = shallowRef(new FormState(props.type, undefined, types));

function start(): void {
  form.value = new FormState(props.type, undefined, types);
  emit('change', valueOf());
}
/** Load the named types the asked type refers to, then read the form again so gin can check them. */
async function load(): Promise<void> {
  if (await types.need([props.type]) && !form.value.tried.value) { start(); }
}
function valueOf(): Json | undefined {
  const checked = form.value.checked.value;
  return checked.ok ? checked.value : undefined;
}
function update(draft: Draft): void {
  form.value.update(draft);
  emit('change', valueOf());
}

watch(() => [props.type, props.ident], () => { start(); void load(); });
emit('change', valueOf());
void load();
</script>

<template>
  <div class="ask" data-testid="approval-ask">
    <GinInput :node="form.node" :draft="form.draft.value" path="" :problems="form.problems.value" :label="label ?? 'Your answer'" :required="form.node.kind !== 'obj'" @update="update" />
  </div>
</template>

<style scoped>
.ask { display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); }
</style>
