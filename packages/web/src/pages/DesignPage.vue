<script setup lang="ts">
/**
 * The design gallery: every primitive in its states, one section per URL. For checking the look at every size and in
 * both themes (the e2e scenarios photograph it), and for anyone building a page or a renderer.
 */
import { computed, ref, shallowRef } from 'vue';
import AppPage from '../app/AppPage.vue';
import { DesignSection } from '../app/routes.ts';
import { useParamChoice } from '../app/url.ts';
import { useStores } from '../state/stores.ts';
import ThemePicker from '../components/ThemePicker.vue';
import DesignGin from './design/DesignGin.vue';
import DesignViewers from './design/DesignViewers.vue';
import {
  TONES, UiAvatar, UiBadge, UiBanner, UiButton, UiCard, UiCodeBlock, UiDialog, UiEmpty, UiIconButton, UiInput, UiKbd, UiMarkdown, UiMenu,
  UiPopover, UiSegmented, UiSkeleton, UiSpinner, UiSwitch, UiTabs, UiTextarea, type MenuItem, type TabItem,
} from '../ui/index.ts';

const { toasts, theme } = useStores();
const section = useParamChoice('section', DesignSection, 'actions');

const SECTIONS: readonly TabItem<DesignSection>[] = [
  { value: 'actions', label: 'Actions' },
  { value: 'inputs', label: 'Inputs' },
  { value: 'overlays', label: 'Overlays' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'content', label: 'Content' },
  { value: 'gin', label: 'Gin' },
  { value: 'viewers', label: 'Viewers' },
];

const text = ref('');
const email = ref('not-an-email');
const notes = ref('');
const on = ref(true);
const density = ref<'cosy' | 'compact'>('cosy');
const dialogOpen = ref(false);
const popoverOpen = ref(false);
const popoverAnchor = shallowRef<HTMLElement | null>(null);
const chosen = ref('');

type RowAction = 'rename' | 'duplicate' | 'archive' | 'delete';
const MENU: readonly MenuItem<RowAction>[] = [
  { value: 'rename', label: 'Rename', icon: 'edit', hint: 'F2' },
  { value: 'duplicate', label: 'Duplicate', icon: 'copy' },
  { value: 'archive', label: 'Archive', icon: 'inbox', disabled: true },
  { kind: 'separator' },
  { value: 'delete', label: 'Delete', icon: 'trash', danger: true },
];

const CODE = `import { system, g, fn } from '@harness/sdk';

export const notes = system('notes').with({
  fns: {
    add: fn({ description: 'Add a note.', args: g.obj({ text: g.text() }), returns: g.text() }),
  },
});`;

const MARKDOWN = `## Release notes

The **fs** system can now watch folders, and the chat shows *live* status for every run.

- Pair systems from **Systems → Pair**
- [x] Light and dark themes
- [ ] Voice input

| Fn | Kind | Runs |
|:--|:--:|--:|
| \`fs/read\` | native | 1,204 |
| \`hub/chat\` | llm | 88 |

> Systems connect to the hub; the hub owns every LLM call.

A long path wraps instead of widening the page: /home/harness/projects/a-very-long-folder-name/with/many/levels/of/nesting/and-a-file-name-that-keeps-going.ts

\`\`\`ts
const reply = await ctx.fns.read({ path: 'README.md' });
\`\`\``;

const tones = computed(() => TONES);

function openPopover(event: MouseEvent): void {
  popoverAnchor.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  popoverOpen.value = !popoverOpen.value;
}
</script>

<template>
  <AppPage title="Design" description="The parts every page is built from.">
    <template #actions>
      <ThemePicker v-model="theme.choice.value" />
    </template>
    <UiTabs v-model="section" :tabs="SECTIONS" label="Design sections">
      <template #default="{ value }">
        <div v-if="value === 'actions'" class="grid" data-testid="design-actions">
          <UiCard title="Buttons" subtitle="One primary action per surface.">
            <div class="row">
              <UiButton variant="primary">Save</UiButton>
              <UiButton>Cancel</UiButton>
              <UiButton variant="ghost" icon="refresh">Refresh</UiButton>
              <UiButton variant="danger" icon="trash">Delete</UiButton>
            </div>
            <div class="row">
              <UiButton variant="primary" loading>Saving</UiButton>
              <UiButton disabled>Disabled</UiButton>
              <UiButton size="sm" icon="plus">Small</UiButton>
              <UiButton size="lg" icon-right="arrow-right" variant="primary">Large</UiButton>
            </div>
          </UiCard>
          <UiCard title="Icon buttons" subtitle="Every one has a label for screen readers and a tooltip.">
            <div class="row">
              <UiIconButton icon="bell" label="Notifications" :badge="3" />
              <UiIconButton icon="inbox" label="Inbox" :badge="true" />
              <UiIconButton icon="wrap" label="Wrap" :pressed="on" @click="on = !on" />
              <UiIconButton icon="settings" label="Settings" />
              <UiIconButton icon="trash" label="Delete" disabled />
            </div>
          </UiCard>
          <UiCard title="Menu" :subtitle="chosen === '' ? 'Arrow keys, Home, End and letters move; Enter chooses.' : `Chose: ${chosen}`">
            <UiMenu :items="MENU" label="Row actions" @select="chosen = $event">
              <template #trigger="{ toggle, attrs }">
                <UiButton icon="more" v-bind="attrs" data-testid="design-menu" @click="toggle">Actions</UiButton>
              </template>
            </UiMenu>
          </UiCard>
        </div>

        <div v-else-if="value === 'inputs'" class="grid" data-testid="design-inputs">
          <UiCard title="Text">
            <div class="stack">
              <UiInput v-model="text" label="Search" icon="search" placeholder="Fns, files, sessions…" clearable type="search" />
              <UiInput v-model="email" label="Email" type="email" error="Enter an email address." />
              <UiInput v-model="text" label="Name" hint="Shown to the people you chat with." />
            </div>
          </UiCard>
          <UiCard title="Long text">
            <UiTextarea v-model="notes" label="Notes" placeholder="Grows as you type…" :rows="3" :max-rows="8" />
          </UiCard>
          <UiCard title="Choices">
            <div class="stack">
              <UiSwitch v-model="on" label="Notify me" description="When a turn finishes while I'm away." />
              <UiSegmented v-model="density" :options="[{ value: 'cosy', label: 'Cosy' }, { value: 'compact', label: 'Compact' }]" label="Density" />
            </div>
          </UiCard>
        </div>

        <div v-else-if="value === 'overlays'" class="grid" data-testid="design-overlays">
          <UiCard title="Dialog" subtitle="Focus stays inside; Escape or the backdrop closes it.">
            <UiButton variant="primary" data-testid="design-dialog" @click="dialogOpen = true">Open dialog</UiButton>
          </UiCard>
          <UiCard title="Popover" subtitle="Sized to its content, kept on screen.">
            <UiButton data-testid="design-popover" @click="openPopover">Show popover</UiButton>
          </UiCard>
          <UiCard title="Keys">
            <div class="row"><UiKbd :keys="['Ctrl', 'K']" /> <span class="dim">Search</span> <UiKbd :keys="['Esc']" /> <span class="dim">Close</span></div>
          </UiCard>
        </div>

        <div v-else-if="value === 'feedback'" class="grid" data-testid="design-feedback">
          <UiCard title="Toasts">
            <div class="row">
              <UiButton data-testid="design-toast" @click="toasts.ok('Saved', 'Your changes are live.')">Success</UiButton>
              <UiButton @click="toasts.error(&quot;Couldn't save&quot;, 'The hub is unreachable.')">Error</UiButton>
              <UiButton @click="toasts.push({ title: 'Turn undone', body: '3 files restored.', action: { label: 'Redo', run: () => toasts.ok('Redone') } })">With action</UiButton>
            </div>
          </UiCard>
          <UiCard title="Badges">
            <div class="row">
              <UiBadge v-for="tone in tones" :key="tone" :tone="tone" dot :live="tone === 'accent'">{{ tone }}</UiBadge>
            </div>
          </UiCard>
          <UiCard title="Banners">
            <div class="stack">
              <UiBanner tone="warn" icon="offline">Reconnecting to the hub…</UiBanner>
              <UiBanner tone="ok">Back online</UiBanner>
              <UiBanner tone="danger">The fs system needs setup.<template #actions><UiButton size="sm" variant="ghost">Set up</UiButton></template></UiBanner>
            </div>
          </UiCard>
          <UiCard title="Loading">
            <div class="loading">
              <UiSkeleton shape="circle" :size="40" />
              <UiSkeleton shape="lines" :lines="3" class="grow" />
              <UiSpinner :size="20" />
            </div>
          </UiCard>
          <UiCard title="Empty">
            <UiEmpty icon="inbox" title="All caught up" body="Approvals, replies and finished work show up here." />
          </UiCard>
        </div>

        <DesignGin v-else-if="value === 'gin'" />
        <DesignViewers v-else-if="value === 'viewers'" />

        <div v-else class="grid" data-testid="design-content">
          <UiCard title="Avatars">
            <div class="row">
              <UiAvatar name="Ada Lovelace" presence="online" />
              <UiAvatar name="Grace Hopper" presence="away" :size="40" />
              <UiAvatar name="Chat agent" kind="agent" :size="40" />
              <UiAvatar name="alan@example.com" presence="busy" :size="48" />
            </div>
          </UiCard>
          <UiCard title="Code">
            <UiCodeBlock :code="CODE" language="ts" line-numbers @copied="toasts.ok('Copied')" />
          </UiCard>
          <UiCard title="Markdown" class="wide-card">
            <UiMarkdown :source="MARKDOWN" @copied="toasts.ok('Copied')" />
          </UiCard>
        </div>
      </template>
    </UiTabs>

    <UiDialog v-model:open="dialogOpen" title="Archive this session?" description="You can find it again under Archived.">
      <p class="dim">Runs in progress keep going; their results land in the archived session.</p>
      <template #footer>
        <UiButton @click="dialogOpen = false">Cancel</UiButton>
        <UiButton variant="primary" data-testid="design-dialog-confirm" @click="dialogOpen = false; toasts.ok('Archived')">Archive</UiButton>
      </template>
    </UiDialog>
    <UiPopover v-model:open="popoverOpen" :anchor="popoverAnchor" label="Example popover">
      <div class="popover" data-testid="design-popover-panel">
        <p class="pop-title">fs/read</p>
        <p class="dim">Read a file from a root folder. Takes a path; returns its text and size.</p>
      </div>
    </UiPopover>
  </AppPage>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: var(--space-4); align-items: start; }
.wide-card { grid-column: 1 / -1; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.row + .row { margin-top: var(--space-3); }
.stack { display: grid; gap: var(--space-4); }
.loading { display: flex; align-items: center; gap: var(--space-4); }
.grow { flex: 1; }
.dim { margin: 0; color: var(--text-dim); }
.popover { display: grid; gap: var(--space-1); max-width: 300px; padding: var(--space-4); }
.pop-title { margin: 0; font: var(--weight-medium) var(--text-sm) var(--mono); }
</style>
