<script setup lang="ts">
/**
 * Code or plain text: highlighted in its language by the app's highlighter, with line numbers (which can be hidden),
 * a wrap toggle, and "go to line", which lights the line and scrolls to it (the line is a prop, so a page can keep it
 * in the URL). A text cut short says how much more there is.
 */
import { computed, ref, watch } from 'vue';
import { UiCodeBlock, UiInput, UiSwitch } from '../../ui/index.ts';

const props = withDefaults(defineProps<{
  code: string;
  language?: string;
  filename?: string;
  /** The line to light (1-based); 0 for none. */
  line?: number;
  /** How long the whole text is, when only part of it is shown. */
  total?: number;
  compact?: boolean;
}>(), { language: '', filename: '', line: 0, total: 0, compact: false });

const emit = defineEmits<{ 'update:line': [line: number] }>();
const numbers = ref(true);
const goTo = ref(props.line > 0 ? String(props.line) : '');
watch(() => props.line, (line) => { goTo.value = line > 0 ? String(line) : ''; });
const count = computed(() => props.code.split('\n').length);

function go(): void {
  const n = Number.parseInt(goTo.value, 10);
  emit('update:line', Number.isFinite(n) ? Math.max(1, Math.min(count.value, n)) : 0);
}
const shown = computed(() => (props.compact ? props.code.split('\n').slice(0, 8).join('\n') : props.code));
</script>

<template>
  <div class="code-viewer" data-testid="code-view">
    <div v-if="!compact" class="tools">
      <UiSwitch v-model="numbers" label="Line numbers" />
      <form class="go" @submit.prevent="go">
        <UiInput v-model="goTo" type="number" label="Go to line" hide-label :placeholder="`Line (1–${count})`" size="sm" @enter="go" />
      </form>
      <span class="lines">{{ count.toLocaleString() }} {{ count === 1 ? 'line' : 'lines' }}</span>
    </div>
    <UiCodeBlock :code="shown" :language="language" :filename="filename" :line-numbers="numbers && !compact" :mark="line" :max-height="compact ? 200 : 0" />
    <p v-if="total > code.length" class="cut">Showing the first {{ code.length.toLocaleString() }} of {{ total.toLocaleString() }} characters.</p>
  </div>
</template>

<style scoped>
.code-viewer { display: grid; gap: var(--space-2); min-width: 0; }
.tools { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
.go { width: 10rem; }
.lines { margin-left: auto; color: var(--text-faint); font-size: var(--text-xs); }
.cut { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
