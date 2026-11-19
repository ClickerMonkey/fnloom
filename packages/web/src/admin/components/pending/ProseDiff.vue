<script setup lang="ts">
/**
 * A text before and after (a description, a changed paragraph), as running prose with the words removed struck out
 * and those added marked. Given `words`, it draws that word diff as it is.
 */
import { computed } from 'vue';
import { wordDiff, type DiffLine } from '../../logic/review.ts';

const props = withDefaults(defineProps<{ before?: string | undefined; after?: string | undefined; words?: readonly DiffLine[] | undefined }>(), { before: undefined, after: undefined, words: undefined });
const pieces = computed(() => props.words ?? wordDiff(props.before ?? '', props.after ?? ''));
</script>

<template>
  <p class="prose" data-testid="prose-diff">
    <template v-for="(piece, index) in pieces" :key="index">
      <del v-if="piece.kind === 'remove'">{{ piece.text }}</del><ins
        v-else-if="piece.kind === 'add'"
      >{{ piece.text }}</ins><span v-else>{{ piece.text }}</span>
    </template>
  </p>
</template>

<style scoped>
.prose { margin: 0; line-height: var(--leading); white-space: pre-wrap; overflow-wrap: anywhere; }
del { border-radius: 3px; background: var(--danger-soft); color: var(--danger); text-decoration: line-through; text-decoration-thickness: 1px; }
ins { border-radius: 3px; background: var(--ok-soft); color: var(--ok); text-decoration: none; }
</style>
