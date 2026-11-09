<script setup lang="ts">
/**
 * A gin expression read as code: the layout of `layoutExpr` (one line per statement, wrapped only past the width),
 * coloured by token, with each node's comment behind an info icon at the end of its line and gin's problems marked
 * on the line where their node starts.
 */
import type { ExprDef } from '@aeye/gin';
import { computed, inject, ref } from 'vue';
import { useCodeWidth } from '../codeWidth.ts';
import { UiIcon } from '../../ui/index.ts';
import type { ExprProblem } from '../logic/expr.ts';
import { layoutExpr, type CodeLine } from '../logic/layout.ts';
import { EXPR_TOOLS, sharedExprTools } from '../state.ts';
import GinNote from './GinNote.vue';

const props = withDefaults(defineProps<{
  def: ExprDef;
  problems?: readonly ExprProblem[];
}>(), { problems: () => [] });

const tools = inject(EXPR_TOOLS, sharedExprTools, true);
const root = ref<HTMLElement | null>(null);
const probe = ref<HTMLElement | null>(null);
/** Characters that fit across the box, so a phone wraps sooner than a desktop. */
const width = useCodeWidth(root, probe);
const lines = computed(() => layoutExpr(props.def, tools, width.value));
const notesOf = (line: CodeLine): string[] => line.marks.map((m) => m.note).filter((n) => n !== '');
const problemsOf = (line: CodeLine): ExprProblem[] => props.problems.filter((p) => line.marks.some((m) => m.path === p.path));
</script>

<template>
  <div ref="root" class="gin-code" role="code" data-testid="gin-code">
    <span ref="probe" class="probe" aria-hidden="true">0000000000</span>
    <div
      v-for="(line, i) in lines" :key="i" class="line" :class="{ bad: problemsOf(line).length > 0 }" :style="{ paddingLeft: `${line.depth * 2}ch` }"
      :data-paths="line.marks.map((m) => m.path).join(' ')"
    >
      <span v-for="(t, j) in line.tokens" :key="j" :class="`t-${t.kind}`">{{ t.text }}</span>
      <GinNote v-for="(note, n) in notesOf(line)" :key="`n${n}`" class="note" :model-value="note" label="Comment" />
      <span v-for="(p, n) in problemsOf(line)" :key="`p${n}`" class="problem" :class="p.severity" :title="p.message" role="img" :aria-label="p.message">
        <UiIcon :name="p.severity === 'error' ? 'error' : 'warning'" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.gin-code { position: relative; min-width: 0; padding: var(--space-2) var(--space-3); overflow-x: auto; border-radius: var(--radius); background: var(--code-bg); font: var(--text-sm)/1.55 var(--mono); }
.probe { position: absolute; visibility: hidden; white-space: pre; }
.line { display: block; min-height: 1.55em; white-space: pre-wrap; overflow-wrap: anywhere; }
.line.bad { text-decoration: underline wavy var(--danger); text-decoration-skip-ink: none; text-underline-offset: 3px; }
.t-keyword { color: var(--accent); }
.t-string { color: light-dark(oklch(0.5 0.13 150), oklch(0.78 0.12 150)); }
.t-number, .t-literal { color: light-dark(oklch(0.55 0.15 50), oklch(0.8 0.12 60)); }
.t-type { color: light-dark(oklch(0.5 0.12 290), oklch(0.78 0.1 290)); }
.t-punct { color: var(--text-dim); }
.t-name { font-weight: var(--weight-medium); }
.note { margin-left: 1ch; }
.problem { display: inline-flex; margin-left: 1ch; color: var(--danger); font-size: 12px; vertical-align: middle; }
.problem.warning, .problem.info { color: var(--warn); }
</style>
