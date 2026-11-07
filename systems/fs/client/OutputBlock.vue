<script setup lang="ts">
/** A command's output: stdout and stderr, folded to a few lines until expanded, scrolling inside itself. */
import { lineCount } from '../shared/format.ts';
import { computed, ref } from 'vue';

const props = defineProps<{ stdout: string; stderr: string; /** Lines shown before "Show all". */ fold?: number }>();
const expanded = ref(false);
const limit = computed(() => props.fold ?? 12);
const total = computed(() => lineCount(props.stdout) + lineCount(props.stderr));
const long = computed(() => total.value > limit.value);
const empty = computed(() => props.stdout.trim() === '' && props.stderr.trim() === '');
</script>

<template>
  <div class="output" :class="{ folded: long && !expanded }" :style="{ '--fold-lines': limit }">
    <p v-if="empty" class="none">No output.</p>
    <pre v-if="stdout.trim() !== ''" class="stream">{{ stdout }}</pre>
    <pre v-if="stderr.trim() !== ''" class="stream err" aria-label="Errors">{{ stderr }}</pre>
    <button v-if="long" type="button" class="more" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? 'Show less' : `Show all ${total} lines` }}
    </button>
  </div>
</template>

<style scoped>
.output {
  position: relative;
  border-radius: var(--radius-sm);
  background: var(--code-bg);
  overflow: hidden;
}
.stream {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font: var(--text-xs)/1.55 var(--mono);
  white-space: pre;
  overflow-x: auto;
  tab-size: 4;
}
.stream + .stream { border-top: 1px dashed var(--border); }
.err { color: var(--danger); }
.folded .stream { max-height: calc(var(--fold-lines) * 1.55em + var(--space-4)); overflow-y: hidden; }
.folded::after {
  content: '';
  position: absolute;
  inset: auto 0 34px;
  height: 40px;
  background: linear-gradient(transparent, var(--code-bg));
  pointer-events: none;
}
.none { margin: 0; padding: var(--space-2) var(--space-3); color: var(--text-dim); font-size: var(--text-sm); }
.more {
  display: block;
  width: 100%;
  padding: var(--space-2);
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--accent);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--fast) var(--ease);
}
.more:hover { background: var(--accent-soft); }
</style>
