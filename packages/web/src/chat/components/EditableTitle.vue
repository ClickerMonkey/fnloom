<script setup lang="ts">
/** A title that becomes a text box on click: Enter (or leaving it) saves, Escape cancels. */
import { nextTick, ref } from 'vue';

const props = withDefaults(defineProps<{ value: string; placeholder?: string }>(), { placeholder: 'New chat' });
const emit = defineEmits<{ save: [title: string] }>();

const editing = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

async function start(): Promise<void> {
  draft.value = props.value;
  editing.value = true;
  await nextTick();
  input.value?.select();
}

function save(): void {
  if (!editing.value) { return; }
  editing.value = false;
  const title = draft.value.trim();
  if (title !== '' && title !== props.value) { emit('save', title); }
}

defineExpose({ start });
</script>

<template>
  <input
    v-if="editing" ref="input" v-model="draft" class="title-input" aria-label="Chat title" maxlength="120" data-testid="title-input"
    @keydown.enter.prevent="save" @keydown.escape.stop.prevent="editing = false" @blur="save"
  />
  <button v-else type="button" class="title" :title="`${value || placeholder} · click to rename`" data-testid="chat-title" @click="start">
    <span class="text">{{ value || placeholder }}</span>
  </button>
</template>

<style scoped>
.title, .title-input { min-width: 0; height: 36px; padding: 0 var(--space-2); border-radius: var(--radius); font: inherit; font-size: var(--text-md); font-weight: var(--weight-strong); }
.title { display: flex; align-items: center; max-width: 100%; border: 1px solid transparent; background: transparent; color: var(--text); text-align: left; }
.title:hover { border-color: var(--border); }
.title:focus-visible { outline: none; box-shadow: var(--ring); }
.text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title-input { width: min(100%, 420px); border: 1px solid var(--accent); background: var(--surface); color: var(--text); box-shadow: var(--ring); }
.title-input:focus { outline: none; }
</style>
