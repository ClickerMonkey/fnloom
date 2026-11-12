<script setup lang="ts">
/**
 * A system's component previews as a gallery: each component with its named states (empty, loading, error, typical,
 * long), each state's phone and desktop shots side by side in the theme picked above, opened large on a click. With
 * no image links (`urls`, from the hub) each component says what it was shot in. `limit` shows that many components
 * and says how many more there are (the install card); the review page shows them all.
 */
import type { PreviewShot } from '@harness/core';
import { computed, ref } from 'vue';
import { UiSegmented, type SegmentOption } from '../../ui/index.ts';
import UiImageViewer from '../../ui/UiImageViewer.vue';
import { previewGroups, shotsIn, shotSummary, type PreviewTheme } from './gallery.ts';

const props = withDefaults(defineProps<{
  shots: readonly PreviewShot[];
  limit?: number | undefined;
  /** Image links by content hash. */
  urls?: Readonly<Record<string, string>>;
}>(), { limit: undefined, urls: () => ({}) });
const groups = computed(() => previewGroups(props.shots));
const shown = computed(() => (props.limit === undefined ? groups.value : groups.value.slice(0, props.limit)));
const pictures = computed(() => props.shots.some((shot) => props.urls[shot.image.hash] !== undefined));
const THEMES: readonly SegmentOption<PreviewTheme>[] = [{ value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }];
const theme = ref<PreviewTheme>('light');
const large = ref<{ src: string; alt: string } | undefined>(undefined);
const altOf = (shot: PreviewShot): string => `${shot.component}, ${shot.state}, ${shot.viewport}, ${shot.theme}`;
const largeOpen = computed({ get: () => large.value !== undefined, set: (open: boolean) => { if (!open) { large.value = undefined; } } });
</script>

<template>
  <div class="gallery-wrap">
    <UiSegmented v-if="pictures" v-model="theme" class="theme" :options="THEMES" label="Theme of the shots" data-testid="checks-preview-theme" />
    <ul class="gallery" :class="{ pictures }" data-testid="checks-previews">
      <li v-for="group in shown" :key="group.component" class="component">
        <span class="head"><span class="name">{{ group.component }}</span><span v-if="!pictures" class="dim">{{ shotSummary(group) }}</span></span>
        <ul v-if="pictures" class="states">
          <li v-for="state in group.states" :key="state.state" class="state">
            <span class="state-name">{{ state.state }}</span>
            <span class="shots">
              <template v-for="{ shot, url } in shotsIn(state, theme, urls)" :key="shot.viewport">
                <button v-if="url" type="button" class="shot" :class="shot.viewport" :title="altOf(shot)" data-testid="checks-preview-shot" @click="large = { src: url, alt: altOf(shot) }">
                  <img :src="url" :alt="altOf(shot)" loading="lazy" decoding="async" />
                </button>
              </template>
            </span>
          </li>
        </ul>
        <p v-else class="state-list">{{ group.states.map((state) => state.state).join(' · ') }}</p>
      </li>
    </ul>
    <p v-if="shown.length < groups.length" class="dim">And {{ groups.length - shown.length }} more components.</p>
    <UiImageViewer v-if="large" v-model:open="largeOpen" :src="large.src" :alt="large.alt" />
  </div>
</template>

<style scoped>
.gallery-wrap { display: grid; gap: var(--space-3); min-width: 0; }
.theme { justify-self: start; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: var(--space-2); align-items: start; margin: 0; padding: 0; list-style: none; }
/* auto-fit so a short list stretches across the row; tracks wide enough that a shot's text can be read */
.gallery.pictures { grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr)); gap: var(--space-3); }
.component { display: grid; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); min-width: 0; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-2); }
.name { font-family: var(--mono); font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.states { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.state { display: grid; gap: 4px; min-width: 0; }
.state-name { color: var(--text-dim); font-size: var(--text-xs); }
.shots { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.shot { display: block; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); overflow: hidden; cursor: zoom-in; }
.shot:hover { border-color: var(--border-strong, var(--accent)); }
.shot:focus-visible { outline: none; box-shadow: var(--ring); }
.shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
/* the phone shot as tall as the desktop one beside it (9/16 against 16/10 makes it about a quarter of the pair), both capped so one component on a wide row stays a sensible size */
.shot.phone { flex: 0 1 26%; max-width: 225px; min-width: 0; aspect-ratio: 9 / 16; }
.shot.desktop { flex: 1 1 0; min-width: 0; max-width: 640px; aspect-ratio: 16 / 10; }
.state-list { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
