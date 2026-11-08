<script setup lang="ts">
/**
 * A block of code: its language or file name, a copy button that confirms with a check, a wrap toggle, optional line
 * numbers, and syntax colours from the app's highlighter (`HIGHLIGHTER`; drawn as text spans, never HTML). Long lines
 * scroll inside the block (or wrap), never widening the page; tall code scrolls past `maxHeight`. A marked line
 * (`mark`, with line numbers) is lit and scrolled into view.
 */
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import UiIconButton from './UiIconButton.vue';
import { copyText } from './clipboard.ts';
import { tokenLines, useTokens, type Token } from './code/highlighter.ts';

const props = withDefaults(defineProps<{
  code: string;
  language?: string;
  filename?: string;
  lineNumbers?: boolean;
  wrap?: boolean;
  /** Px; 0 for no limit. */
  maxHeight?: number;
  /** A line to light and scroll to (1-based, with line numbers); 0 for none. */
  mark?: number;
}>(), { language: '', filename: '', lineNumbers: false, wrap: false, maxHeight: 480, mark: 0 });

const emit = defineEmits<{ copied: [ok: boolean] }>();
const wrapped = ref(props.wrap);
const copied = ref(false);
const tokens = useTokens(() => props.code.replace(/\n$/, ''), () => props.language);
const lineTokens = computed(() => tokenLines(tokens.value));
const pre = useTemplateRef<HTMLElement>('pre');
watch(() => [props.mark, lineTokens.value.length] as const, async ([mark]) => {
  if (mark <= 0 || !props.lineNumbers) { return; }
  await nextTick();
  pre.value?.querySelector('.line.marked')?.scrollIntoView({ block: 'center', behavior: 'instant' });
}, { immediate: true });
const tokenClass = (token: Token): string | undefined => (token.kind === 'plain' ? undefined : `tok-${token.kind}`);
const caption = computed(() => props.filename || props.language || 'text');
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  const ok = await copyText(props.code);
  emit('copied', ok);
  if (!ok) { return; }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => { copied.value = false; }, 1_600);
}
onBeforeUnmount(() => { clearTimeout(timer); });
</script>

<template>
  <figure class="ui-code" :class="{ wrapped }">
    <figcaption class="bar">
      <span class="caption">{{ caption }}</span>
      <span class="tools">
        <UiIconButton icon="wrap" :label="wrapped ? 'Scroll long lines' : 'Wrap long lines'" size="sm" :pressed="wrapped" @click="wrapped = !wrapped" />
        <UiIconButton :icon="copied ? 'check' : 'copy'" :label="copied ? 'Copied' : 'Copy code'" size="sm" class="copy" :class="{ copied }" @click="copy" />
      </span>
    </figcaption>
    <pre ref="pre" class="pre" :style="maxHeight > 0 ? { maxHeight: `${maxHeight}px` } : undefined" tabindex="0"><code :class="language === '' ? undefined : `language-${language}`"><template v-if="lineNumbers"><span v-for="(line, index) in lineTokens" :key="index" class="line" :class="{ marked: index + 1 === mark }"><span class="number" aria-hidden="true">{{ index + 1 }}</span><span v-for="(token, t) in line" :key="t" :class="tokenClass(token)">{{ token.text }}</span>
</span></template><template v-else><span v-for="(token, t) in tokens" :key="t" :class="tokenClass(token)">{{ token.text }}</span></template></code></pre>
  </figure>
</template>

<style scoped>
.ui-code { margin: 0; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--code-bg); overflow: hidden; }
.bar { display: flex; align-items: center; gap: var(--space-2); min-height: 36px; padding: 0 var(--space-1) 0 var(--space-3); border-bottom: 1px solid var(--border); }
.caption { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); font: var(--text-xs) var(--mono); }
.tools { display: flex; gap: 2px; }
.copied { color: var(--ok); }
.pre { margin: 0; padding: var(--space-3) var(--space-4); overflow: auto; font: 13px/1.6 var(--mono); tab-size: 2; color: var(--text); }
.pre:focus-visible { outline: none; box-shadow: inset var(--ring); }
.wrapped .pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.line { display: block; }
.line.marked { margin: 0 calc(-1 * var(--space-4)); padding: 0 var(--space-4); background: color-mix(in oklab, var(--accent) 14%, transparent); }
.tok-comment { color: var(--text-faint); font-style: italic; }
.tok-string { color: light-dark(oklch(0.5 0.13 150), oklch(0.78 0.12 150)); }
.tok-number, .tok-literal { color: light-dark(oklch(0.55 0.15 50), oklch(0.8 0.12 60)); }
.tok-keyword { color: var(--accent); }
.number { display: inline-block; width: 3ch; margin-right: var(--space-3); color: var(--text-faint); text-align: right; user-select: none; }
</style>
