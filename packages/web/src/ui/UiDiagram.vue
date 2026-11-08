<script setup lang="ts">
/**
 * A diagram (mermaid) drawn by the app's renderer (`DIAGRAMS`) as an image from a blob URL, following light and dark
 * (it draws again when the theme changes), with its source a toggle away and opened large on a click. While it draws,
 * a skeleton holds its place; without a renderer, or when the source doesn't draw, the source shows as code with a
 * note saying why.
 */
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import UiCodeBlock from './UiCodeBlock.vue';
import UiIconButton from './UiIconButton.vue';
import UiImageViewer from './UiImageViewer.vue';
import UiSkeleton from './UiSkeleton.vue';
import { DIAGRAMS } from './markdown/diagram.ts';
import { useDarkTheme } from './theme.ts';

const props = withDefaults(defineProps<{ source: string; language?: string; title?: string }>(), { language: 'mermaid', title: 'Diagram' });

const renderer = inject(DIAGRAMS, undefined);
const dark = useDarkTheme();
const url = shallowRef<string | undefined>(undefined);
const problem = ref('');
const drawing = ref(false);
const showSource = ref(false);
const large = ref(false);
const supported = computed(() => renderer?.languages.includes(props.language) === true);
let generation = 0;

function release(): void {
  if (url.value !== undefined) { URL.revokeObjectURL(url.value); }
  url.value = undefined;
}

watch(() => [props.source, props.language, dark.value, supported.value] as const, async ([source, language, isDark]) => {
  const mine = ++generation;
  if (renderer === undefined || !supported.value) { release(); return; }
  drawing.value = true;
  const result = await renderer.render(source, language, isDark).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
  if (mine !== generation) { return; }
  drawing.value = false;
  release();
  if (result.ok) {
    problem.value = '';
    url.value = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
  } else {
    problem.value = result.problem;
  }
}, { immediate: true });
onBeforeUnmount(release);

const note = computed(() => {
  if (!supported.value) { return `${props.language} diagrams are shown as their source here.`; }
  return problem.value === '' ? '' : `This diagram didn't draw: ${problem.value}`;
});
</script>

<template>
  <figure class="ui-diagram" data-testid="diagram">
    <div v-if="supported && url && !showSource" class="stage">
      <button type="button" class="open" :aria-label="`Open ${title} large`" @click="large = true"><img :src="url" :alt="title" /></button>
    </div>
    <UiSkeleton v-else-if="supported && drawing && !showSource" shape="block" />
    <UiCodeBlock v-else :code="source" :language="language" :filename="title" :max-height="360" />
    <figcaption class="bar">
      <span v-if="note !== ''" class="note">{{ note }}</span>
      <UiIconButton v-if="supported && url" :icon="showSource ? 'image' : 'file'" size="sm" :label="showSource ? 'Show the diagram' : 'Show the source'" :pressed="showSource" @click="showSource = !showSource" />
    </figcaption>
    <UiImageViewer v-if="url" v-model:open="large" :src="url" :alt="title" />
  </figure>
</template>

<style scoped>
.ui-diagram { display: grid; gap: var(--space-1); margin: 0; min-width: 0; }
.stage { display: grid; place-items: center; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: auto; }
.open { padding: 0; border: 0; background: none; cursor: zoom-in; max-width: 100%; }
.open:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--radius); }
.open img { display: block; max-width: 100%; height: auto; }
.bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); min-height: 0; }
.bar:empty { display: none; }
.note { flex: 1; color: var(--text-faint); font-size: var(--text-xs); }
</style>
