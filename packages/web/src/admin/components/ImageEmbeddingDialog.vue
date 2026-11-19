<script setup lang="ts">
/**
 * Where the index embeds pictures, one choice: off, the text model's space (when it embeds pictures beside text), or a
 * model of their own (a second space). The embedders connected now that embed pictures are offered with what they
 * read; the space in use now is shown, or why there is none.
 */
import { IMAGE_EMBEDDING_USES, type ImageEmbedding, type ImageEmbeddingUse, type ImageEmbeddingView } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBanner, UiButton, UiDialog, UiSegmented, UiSelect, type SegmentOption } from '../../ui/index.ts';
import { embedderOptions, embedderReads, IMAGE_USE_WORDS, imageDraft, imageEmbeddingOf, spaceText, type ImageDraft } from '../logic/images.ts';

const props = withDefaults(defineProps<{ view: ImageEmbeddingView | undefined; busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [value: ImageEmbedding] }>();

const draft = ref<ImageDraft>(imageDraft(undefined));
const tried = ref(false);
watch(open, (isOpen) => { if (isOpen) { draft.value = imageDraft(props.view); tried.value = false; } }, { immediate: true });

const USES: readonly SegmentOption<ImageEmbeddingUse>[] = IMAGE_EMBEDDING_USES.map((value) => ({ value, label: IMAGE_USE_WORDS[value].label, icon: IMAGE_USE_WORDS[value].icon }));
const use = computed({ get: () => draft.value.use, set: (value: ImageEmbeddingUse) => { draft.value = { ...draft.value, use: value }; } });
const embedder = computed({ get: () => draft.value.embedder, set: (value: string) => { draft.value = { ...draft.value, embedder: value }; } });
const options = computed(() => embedderOptions(props.view?.options ?? [], draft.value.embedder));
const chosen = computed(() => props.view?.options.find((option) => option.embedder === draft.value.embedder));
const now = computed(() => spaceText(props.view?.state, props.view?.text));
const checked = computed(() => imageEmbeddingOf(draft.value));
const error = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));
function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Pictures" description="Where the index embeds pictures, so search can find them by a picture or by text." width="560px">
    <form class="form" novalidate data-testid="images-form" :data-use="draft.use" @submit.prevent="save">
      <UiSegmented v-model="use" :options="USES" label="Pictures" data-testid="images-use" />
      <p class="dim" data-testid="images-about">{{ IMAGE_USE_WORDS[draft.use].about }}</p>
      <p v-if="draft.use === 'text' && view" class="dim">The text model is <code>{{ view.text }}</code>.</p>
      <template v-if="draft.use === 'model'">
        <UiSelect v-model="embedder" :options="options" label="Model" :error="error" data-testid="images-model" />
        <p v-if="chosen" class="dim" data-testid="images-reads">Reads {{ embedderReads(chosen) }}.</p>
        <p v-if="(view?.options.length ?? 0) === 0" class="dim">No system offers a model that embeds pictures yet: add one (a provider model with image embedding).</p>
      </template>
      <UiBanner :tone="now.works ? 'ok' : 'warn'" :icon="now.works ? 'success' : 'info'" data-testid="images-now">
        <span><strong>Now:</strong> {{ now.text }}</span>
      </UiBanner>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="images-save" @click="save">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); min-width: 0; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
</style>
