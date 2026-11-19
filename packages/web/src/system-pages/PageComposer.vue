<script setup lang="ts">
/**
 * The chat's composer on a system page (`components.Composer`, item 8): the same box, keys and Send, with Stop beside
 * it while work runs. A page has no mentions, commands, files, dictation or reply strip, so those stay closed; the
 * text is the page's (`v-model`), `@send` asks to send it and `@stop` to stop what runs (the composer's Cancel).
 */
import type { ComposerProps } from '@harness/sdk';
import Composer from '../chat/components/Composer.vue';
import { isTouch } from '../chat/dom.ts';
import type { ControlVerb } from '../chat/logic/controls.ts';
import { useNow } from '../ui/now.ts';

const props = withDefaults(defineProps<ComposerProps>(), { placeholder: 'Message', sending: false, running: false, stopping: false, disabled: false, note: '' });
const emit = defineEmits<{ 'update:modelValue': [text: string]; send: []; stop: [] }>();

const touch = isTouch();
const now = useNow();
const PICKER = { open: false, kind: undefined, items: [], active: 0, loading: false } as const;
const VOICE = { available: false, state: 'idle', startedAt: 0, problem: '' } as const;
const REPLY_ALL = { shown: false, on: false } as const;

/** Cancel stops the work; pausing and resuming are the chat's own, not a page's. */
function control(verb: ControlVerb): void {
  if (verb === 'cancel') { emit('stop'); }
}
</script>

<template>
  <Composer
    :text="modelValue" :placeholder="placeholder" :tokens="[]" :can-send="!props.disabled && modelValue.trim() !== ''" :sending="sending" :running="running" :paused="false"
    :stopping="stopping" :picker="PICKER" :files="[]" :reply-all="REPLY_ALL" answerers="" :can-attach="false" :voice="VOICE" :now="now" :touch="touch" :note="note"
    @input="(text) => emit('update:modelValue', text)" @send="emit('send')" @control="(verb) => control(verb)"
  />
</template>
