<script setup lang="ts">
/**
 * Audio or video with the browser's own player (seeking needs the content route's Range support, which presigned
 * downloads have), and its transcript beside it when there is one: the line playing is lit as it plays, and a click
 * on a line with a time seeks there.
 */
import { computed, ref, useTemplateRef } from 'vue';
import { clockOf, lineAt, transcriptLines } from '../logic/transcript.ts';

const props = withDefaults(defineProps<{ src: string; kind: 'audio' | 'video'; transcript?: string; title?: string }>(), { transcript: '', title: '' });

const player = useTemplateRef<HTMLMediaElement>('player');
const time = ref(0);
const lines = computed(() => transcriptLines(props.transcript));
const playing = computed(() => lineAt(lines.value, time.value));

function seek(at: number | undefined): void {
  if (at === undefined || player.value === null) { return; }
  player.value.currentTime = at;
  void player.value.play().catch(() => undefined);
}
function tick(event: Event): void {
  if (event.target instanceof HTMLMediaElement) { time.value = event.target.currentTime; }
}
</script>

<template>
  <div class="media-viewer" :class="kind" data-testid="media-view">
    <video v-if="kind === 'video'" ref="player" class="player" :src="src" controls playsinline preload="metadata" :aria-label="title || 'Video'" @timeupdate="tick"></video>
    <audio v-else ref="player" class="player" :src="src" controls preload="metadata" :aria-label="title || 'Audio'" @timeupdate="tick"></audio>
    <section v-if="lines.length > 0" class="transcript" aria-label="Transcript">
      <h3 class="heading">Transcript</h3>
      <ol class="lines">
        <li v-for="(line, i) in lines" :key="i" :class="{ playing: i === playing }">
          <button v-if="line.at !== undefined" type="button" class="stamp" :aria-label="`Play from ${clockOf(line.at)}`" @click="seek(line.at)">{{ clockOf(line.at) }}</button>
          <span class="text">{{ line.text }}</span>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.media-viewer { display: grid; gap: var(--space-3); min-width: 0; }
.player { width: 100%; border-radius: var(--radius); background: var(--surface-2); }
.video .player { max-height: min(60dvh, 560px); background: #000; }
.transcript { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-dim); }
.lines { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; max-height: 360px; overflow: auto; }
.lines li { display: flex; gap: var(--space-2); align-items: baseline; padding: 2px var(--space-2); border-radius: 6px; }
.lines li.playing { background: color-mix(in oklab, var(--accent) 14%, transparent); }
.stamp { flex: none; padding: 0; border: 0; background: none; color: var(--accent); font: var(--text-xs) var(--mono); cursor: pointer; }
.stamp:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 4px; }
.text { font-size: var(--text-sm); }
</style>
