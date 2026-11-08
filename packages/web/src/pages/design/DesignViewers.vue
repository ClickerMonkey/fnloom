<script setup lang="ts">
/** The design gallery's viewers section: each resource viewer drawn from sample data, without a hub. */
import { ref } from 'vue';
import { UiCard, UiDiagram, UiMarkdown } from '../../ui/index.ts';
import CodeViewer from '../../resources/viewers/CodeViewer.vue';
import HtmlPreview from '../../resources/viewers/HtmlPreview.vue';
import ImageViewer from '../../resources/viewers/ImageViewer.vue';
import JsonTree from '../../resources/viewers/JsonTree.vue';
import MediaViewer from '../../resources/viewers/MediaViewer.vue';
import PagesViewer from '../../resources/viewers/PagesViewer.vue';
import TableViewer from '../../resources/viewers/TableViewer.vue';
import { SAMPLE_CODE, SAMPLE_HTML, SAMPLE_JSON, SAMPLE_MARKDOWN, SAMPLE_PAGES, SAMPLE_SVG, SAMPLE_TABLES, SAMPLE_TRANSCRIPT } from './samples.ts';

const line = ref(4);
const page = ref(1);
</script>

<template>
  <div class="design-viewers" data-testid="design-viewers">
    <UiCard title="Code" subtitle="Highlighted, with line numbers and go to line.">
      <CodeViewer v-model:line="line" :code="SAMPLE_CODE" language="ts" filename="notes.ts" />
    </UiCard>
    <UiCard title="Markdown" subtitle="With a diagram and math.">
      <UiMarkdown :source="SAMPLE_MARKDOWN" />
    </UiCard>
    <UiCard title="Table" subtitle="Sheets, sort, filter, sticky header." class="wide">
      <TableViewer :tables="SAMPLE_TABLES" />
    </UiCard>
    <UiCard title="JSON">
      <JsonTree :text="SAMPLE_JSON" />
    </UiCard>
    <UiCard title="Image">
      <ImageViewer :src="SAMPLE_SVG" alt="Sample shapes" />
    </UiCard>
    <UiCard title="Pages">
      <PagesViewer v-model:page="page" :pages="SAMPLE_PAGES" />
    </UiCard>
    <UiCard title="Html" subtitle="Sandboxed: its script doesn't run.">
      <HtmlPreview :html="SAMPLE_HTML" title="Release notes" />
    </UiCard>
    <UiCard title="Diagram">
      <UiDiagram source="graph TD; Hub --> fs; Hub --> web" title="Systems" />
    </UiCard>
    <UiCard title="Audio with a transcript">
      <MediaViewer src="" kind="audio" :transcript="SAMPLE_TRANSCRIPT" title="Walkthrough" />
    </UiCard>
  </div>
</template>

<style scoped>
.design-viewers { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: var(--space-4); align-items: start; }
.wide { grid-column: 1 / -1; }
</style>
