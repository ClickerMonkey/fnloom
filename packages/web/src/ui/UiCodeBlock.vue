<script setup lang="ts">
/**
 * A block of code: its language or file name, a copy button that confirms with a check, a wrap toggle, optional line
 * numbers. Long lines scroll inside the block (or wrap), never widening the page; tall code scrolls past `maxHeight`.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import UiIconButton from './UiIconButton.vue';
import { copyText } from './clipboard.ts';

const props = withDefaults(defineProps<{
  code: string;
  language?: string;
  filename?: string;
  lineNumbers?: boolean;
  wrap?: boolean;
  /** Px; 0 for no limit. */
  maxHeight?: number;
}>(), { language: '', filename: '', lineNumbers: false, wrap: false, maxHeight: 480 });

const emit = defineEmits<{ copied: [ok: boolean] }>();
const wrapped = ref(props.wrap);
const copied = ref(false);
const lines = computed(() => props.code.replace(/\n$/, '').split('\n'));
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
    <pre class="pre" :style="maxHeight > 0 ? { maxHeight: `${maxHeight}px` } : undefined" tabindex="0"><code :class="language === '' ? undefined : `language-${language}`"><template v-if="lineNumbers"><span v-for="(line, index) in lines" :key="index" class="line"><span class="number" aria-hidden="true">{{ index + 1 }}</span>{{ line }}
</span></template><template v-else>{{ code }}</template></code></pre>
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
.number { display: inline-block; width: 3ch; margin-right: var(--space-3); color: var(--text-faint); text-align: right; user-select: none; }
</style>
