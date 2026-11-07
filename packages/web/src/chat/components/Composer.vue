<script setup lang="ts">
/**
 * The composer, pinned under the thread. A textarea that grows with its text up to half the screen, then scrolls;
 * 16px text so phones don't zoom. Enter sends on a hardware keyboard (Shift+Enter breaks the line); on touch Enter
 * breaks the line and the button sends; Ctrl/Cmd+Enter always sends. Mention chips show highlighted in the text.
 *
 * Around it: the picker (`@`, `/`, `!`) floating above, with arrow keys and Enter working only while it is open;
 * the reply or edit strip; the command argument hint; staged files; attach (pick, drop, paste images); dictation;
 * reply-all; and Send, with Stop beside it while a turn runs (Pause and Cancel as the turn allows) or Resume when it
 * is paused. Under it, who will answer. It draws what it is given and reports what the person does.
 */
import type { SessionControls } from '@harness/core';
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { UiButton, UiIcon, UiIconButton, UiMenu, type MenuItem } from '../../ui/index.ts';
import { enterSends, type CommandHint } from '../logic/composer.ts';
import { formatDuration } from '../logic/format.ts';
import type { PickerItem } from '../state/composer.ts';
import type { StagedFile } from '../state/uploads.ts';
import type { VoiceState } from '../state/voice.ts';
import FileChips from './FileChips.vue';
import PickerList from './PickerList.vue';

const props = withDefaults(defineProps<{
  text: string;
  /** Where to put the caret next; applied when it changes. */
  caretRequest?: number | undefined;
  placeholder: string;
  /** Chips in the text (`@label`), highlighted. */
  tokens: readonly string[];
  canSend: boolean;
  sending: boolean;
  running: boolean;
  paused: boolean;
  stopping: boolean;
  controls?: SessionControls | undefined;
  picker: { readonly open: boolean; readonly kind: 'mention' | 'command' | 'invoke' | undefined; readonly items: readonly PickerItem[]; readonly active: number; readonly loading: boolean };
  hint?: CommandHint | undefined;
  files: readonly StagedFile[];
  /** The message being replied to. */
  reply?: { readonly author: string; readonly excerpt: string } | undefined;
  /** Editing an earlier message: sending undoes the turns after it. */
  editing?: boolean;
  replyAll: { readonly shown: boolean; readonly on: boolean };
  /** Who will answer ("Chat agent will answer"). */
  answerers: string;
  canAttach: boolean;
  voice: { readonly available: boolean; readonly state: VoiceState; readonly startedAt: number; readonly problem: string };
  now: number;
  touch: boolean;
  /** A short note under the box ("2 runs moved to background"). */
  note?: string;
}>(), { caretRequest: undefined, controls: undefined, hint: undefined, reply: undefined, editing: false, note: '' });

const emit = defineEmits<{
  input: [text: string, caret: number];
  caret: [caret: number];
  send: [];
  stop: [action: 'pause' | 'cancel'];
  resume: [];
  pickerMove: [delta: number];
  pickerHover: [index: number];
  pick: [item: PickerItem | undefined];
  pickerDismiss: [];
  attach: [files: File[]];
  removeFile: [id: number];
  retryFile: [id: number];
  clearReply: [];
  cancelEdit: [];
  replyAll: [on: boolean];
  voiceStart: [];
  voiceStop: [];
  voiceCancel: [];
  voiceDismiss: [];
  recall: [];
  focus: [focused: boolean];
}>();

const id = useId();
const area = ref<HTMLTextAreaElement | null>(null);
const mirror = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

/** The text cut at each chip, so the mirror can mark them. */
const segments = computed(() => {
  const out: { text: string; chip: boolean }[] = [];
  let rest = props.text;
  const tokens = [...props.tokens].sort((a, b) => b.length - a.length);
  while (rest !== '') {
    let best: { at: number; token: string } | undefined;
    for (const token of tokens) {
      const at = rest.indexOf(token);
      if (at !== -1 && (best === undefined || at < best.at)) { best = { at, token }; }
    }
    if (best === undefined) { out.push({ text: rest, chip: false }); break; }
    if (best.at > 0) { out.push({ text: rest.slice(0, best.at), chip: false }); }
    out.push({ text: best.token, chip: true });
    rest = rest.slice(best.at + best.token.length);
  }
  return out;
});

const stopItems = computed<MenuItem<'pause' | 'cancel'>[]>(() => {
  const controls = props.controls;
  const items: MenuItem<'pause' | 'cancel'>[] = [];
  if (controls?.pause === true) { items.push({ value: 'pause', label: 'Pause', icon: 'pause', hint: 'Resumable' }); }
  if (controls === undefined || controls.cancel) {
    const left = controls?.uncancellable.length ?? 0;
    items.push({ value: 'cancel', label: 'Cancel', icon: 'stop', danger: true, ...(left > 0 ? { hint: `${left} run${left === 1 ? '' : 's'} will finish` } : {}) });
  }
  return items;
});
const recording = computed(() => props.voice.state === 'recording');
const activeId = computed(() => (props.picker.open && props.picker.items.length > 0 ? `${id}-picker-${props.picker.active}` : undefined));

function fit(): void {
  const el = area.value;
  if (el === null) { return; }
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
  if (mirror.value !== null) { mirror.value.scrollTop = el.scrollTop; }
}

function onInput(event: Event): void {
  const el = event.target;
  if (!(el instanceof HTMLTextAreaElement)) { return; }
  emit('input', el.value, el.selectionStart);
  fit();
}

function onCaret(): void {
  const el = area.value;
  if (el !== null) { emit('caret', el.selectionStart); }
}

function onKey(event: KeyboardEvent): void {
  if (props.picker.open) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      emit('pickerMove', event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && props.picker.items.length > 0 && !event.isComposing) {
      event.preventDefault();
      emit('pick', props.picker.items[props.picker.active]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      emit('pickerDismiss');
      return;
    }
  }
  if (event.key === 'Escape' && (props.reply !== undefined || props.editing)) {
    event.stopPropagation();
    if (props.editing) { emit('cancelEdit'); } else { emit('clearReply'); }
    return;
  }
  if (event.key === 'ArrowUp' && props.text === '' && !event.shiftKey) {
    event.preventDefault();
    emit('recall');
    return;
  }
  if (enterSends(event, props.touch)) {
    event.preventDefault();
    if (props.canSend && !props.sending) { emit('send'); }
  }
}

function onPaste(event: ClipboardEvent): void {
  if (!props.canAttach) { return; }
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0) {
    event.preventDefault();
    emit('attach', files);
  }
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (!props.canAttach) { return; }
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) { emit('attach', files); }
}

function onPicked(event: Event): void {
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || el.files === null) { return; }
  emit('attach', [...el.files]);
  el.value = '';
}

watch(() => props.text, () => { void nextTick(fit); });
watch(() => props.caretRequest, (caret) => {
  if (caret === undefined) { return; }
  void nextTick(() => {
    const el = area.value;
    if (el === null) { return; }
    el.focus();
    el.setSelectionRange(caret, caret);
  });
});
onMounted(fit);

defineExpose({ focus: () => { area.value?.focus(); } });
</script>

<template>
  <div class="composer" :class="{ dragging }" data-testid="composer" @dragover.prevent="dragging = canAttach" @dragleave="dragging = false" @drop.prevent="onDrop">
    <div v-if="picker.open && picker.kind" class="picker-slot">
      <PickerList
        :id="`${id}-picker`" :items="picker.items" :active="picker.active" :loading="picker.loading" :kind="picker.kind"
        @pick="emit('pick', $event)" @hover="emit('pickerHover', $event)"
      />
    </div>

    <div v-if="editing" class="strip edit" data-testid="edit-strip">
      <UiIcon name="edit" :size="14" />
      <span class="strip-text">Editing. Sending undoes this turn and everything after it.</span>
      <UiIconButton size="sm" icon="x" label="Stop editing" @click="emit('cancelEdit')" />
    </div>
    <div v-else-if="reply" class="strip" data-testid="reply-strip">
      <UiIcon name="reply" :size="14" />
      <span class="strip-text"><strong>{{ reply.author }}</strong> {{ reply.excerpt }}</span>
      <UiIconButton size="sm" icon="x" label="Don't reply" @click="emit('clearReply')" />
    </div>

    <div v-if="hint" class="hint" data-testid="command-hint">
      <span class="hint-name">/{{ hint.command.name }}</span>
      <span v-for="(arg, i) in hint.command.args" :key="arg.name" class="hint-arg" :class="{ current: i === hint.current }" :title="arg.hint">
        {{ arg.name }}<span v-if="!arg.required" class="optional"> (optional)</span>
      </span>
      <span v-if="hint.command.args[hint.current]" class="hint-help">{{ hint.command.args[hint.current]?.hint }}</span>
    </div>

    <FileChips v-if="files.length > 0" class="files" :files="files" @remove="emit('removeFile', $event)" @retry="emit('retryFile', $event)" />

    <div v-if="voice.problem !== ''" class="strip warn" role="alert">
      <UiIcon name="warning" :size="14" />
      <span class="strip-text">{{ voice.problem }}</span>
      <UiIconButton size="sm" icon="x" label="Dismiss" @click="emit('voiceDismiss')" />
    </div>

    <div class="box">
      <div class="field">
        <div ref="mirror" class="mirror" aria-hidden="true"><template v-for="(segment, i) in segments" :key="i"><mark v-if="segment.chip" class="chip">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template>&#8203;</div>
        <textarea
          ref="area" class="input" :value="text" rows="1" :placeholder="placeholder" aria-label="Message" :aria-expanded="picker.open ? 'true' : 'false'"
          role="combobox" aria-autocomplete="list" :aria-controls="picker.open ? `${id}-picker` : undefined" :aria-activedescendant="activeId"
          enterkeyhint="send" data-testid="composer-input"
          @input="onInput" @keydown="onKey" @keyup="onCaret" @click="onCaret" @select="onCaret" @paste="onPaste" @scroll="fit"
          @focus="emit('focus', true)" @blur="emit('focus', false)"
        />
      </div>
      <div class="tools">
        <div class="left">
          <template v-if="canAttach">
            <input ref="fileInput" class="sr-only" type="file" multiple tabindex="-1" aria-hidden="true" @change="onPicked" />
            <UiIconButton icon="paperclip" label="Attach files" data-testid="attach" @click="fileInput?.click()" />
          </template>
          <template v-if="voice.available">
            <UiIconButton v-if="!recording && voice.state !== 'transcribing'" icon="mic" label="Dictate" data-testid="mic" @click="emit('voiceStart')" />
            <span v-else-if="recording" class="recording" data-testid="recording">
              <span class="rec-dot" aria-hidden="true" />
              <span class="rec-time">{{ formatDuration(Math.max(0, now - voice.startedAt)) }}</span>
              <UiIconButton size="sm" icon="x" label="Discard recording" @click="emit('voiceCancel')" />
              <UiIconButton size="sm" icon="check" label="Stop and transcribe" @click="emit('voiceStop')" />
            </span>
            <span v-else class="transcribing">Transcribing…</span>
          </template>
          <button
            v-if="replyAll.shown" type="button" class="reply-all" :aria-pressed="replyAll.on ? 'true' : 'false'" data-testid="reply-all"
            @click="emit('replyAll', !replyAll.on)"
          >
            Reply all
          </button>
        </div>
        <div class="right">
          <UiButton v-if="paused" size="sm" variant="secondary" icon="play" data-testid="resume" @click="emit('resume')">Resume</UiButton>
          <UiMenu v-else-if="running && stopItems.length > 0" :items="stopItems" label="Stop the turn" side="top" align="end" @select="emit('stop', $event)">
            <template #trigger="{ toggle, attrs }">
              <UiButton size="sm" variant="secondary" icon="stop" v-bind="attrs" :loading="stopping" data-testid="stop" @click="toggle">Stop</UiButton>
            </template>
          </UiMenu>
          <UiIconButton
            class="send" :class="{ ready: canSend }" icon="arrow-up" :label="editing ? 'Save and resend' : 'Send'" :disabled="!canSend || sending"
            data-testid="send" @click="emit('send')"
          />
        </div>
      </div>
    </div>
    <p class="answerers" data-testid="answerers">
      <span>{{ note || answerers }}</span>
      <span v-if="!touch" class="keys">Enter to send · Shift+Enter for a new line</span>
    </p>
  </div>
</template>

<style scoped>
.composer { position: relative; display: grid; gap: var(--space-2); min-width: 0; }
.picker-slot { position: absolute; left: 0; right: 0; bottom: calc(100% + var(--space-2)); z-index: var(--z-popover); }
.strip { display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding: 2px 2px 2px var(--space-3); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-dim); font-size: var(--text-sm); animation: ui-rise-in var(--fast) var(--ease); }
.strip.edit { border-left-color: var(--warn); }
.strip.warn { border-left-color: var(--warn); color: var(--text); }
.strip-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); padding: 0 var(--space-2); font-size: var(--text-sm); color: var(--text-faint); }
.hint-name { font-family: var(--mono); color: var(--text-dim); }
.hint-arg { padding: 0 6px; border-radius: var(--radius-sm); font-family: var(--mono); }
.hint-arg.current { background: var(--accent-soft); color: var(--accent); }
.optional { font-family: var(--font); }
.hint-help { flex-basis: 100%; font-size: var(--text-xs); }
.box {
  display: grid; gap: var(--space-1); padding: var(--space-2) var(--space-2) var(--space-1); border: 1px solid var(--border-strong); border-radius: var(--radius-xl);
  background: var(--surface); box-shadow: var(--shadow-sm); transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.box:focus-within { border-color: var(--accent); box-shadow: var(--ring); }
.dragging .box { border-style: dashed; border-color: var(--accent); background: var(--accent-soft); }
.field { position: relative; display: grid; min-width: 0; }
.mirror, .input {
  grid-area: 1 / 1; margin: 0; padding: var(--space-2) var(--space-2); border: 0; font: inherit; font-size: 16px; line-height: 1.5; letter-spacing: normal;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; tab-size: 4;
}
.mirror { color: transparent; pointer-events: none; overflow: hidden; max-height: 50dvh; }
.chip { color: transparent; background: var(--accent-soft-strong); border-radius: 4px; box-shadow: 0 0 0 1px var(--accent-soft-strong); }
.input { position: relative; min-height: 40px; max-height: 50vh; max-height: 50dvh; resize: none; overflow-y: auto; background: transparent; color: var(--text); caret-color: var(--accent); }
.input:focus { outline: none; }
.input::placeholder { color: var(--text-faint); }
.tools { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.left, .right { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.left { flex-wrap: wrap; }
.right { flex: none; }
.send { border-radius: var(--radius-full); transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease), transform var(--fast) var(--spring); }
.send.ready { background: var(--accent); color: var(--on-accent); }
.send.ready:hover { background: var(--accent-hover); }
.send.ready:active { transform: scale(0.94); }
.reply-all { height: 32px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-full); background: transparent; color: var(--text-dim); font-size: var(--text-sm); }
.reply-all[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.recording { display: inline-flex; align-items: center; gap: var(--space-1); padding-left: var(--space-2); color: var(--danger); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); animation: ui-pulse 1s var(--ease-in-out) infinite; }
.transcribing { padding: 0 var(--space-2); color: var(--text-dim); font-size: var(--text-sm); }
.answerers { display: flex; justify-content: space-between; gap: var(--space-3); margin: 0; padding: 0 var(--space-3); color: var(--text-faint); font-size: var(--text-xs); }
.keys { flex: none; }
@media (max-width: 520px) { .keys { display: none; } }
</style>
