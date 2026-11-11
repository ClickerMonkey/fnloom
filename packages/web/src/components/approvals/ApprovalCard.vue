<script setup lang="ts">
/**
 * One run waiting for approval, wherever it is answered (above the chat's composer, in the inbox): what it is — the
 * preview's one line, or "Allow <fn>?" — and what it will do (the system's preview: SQL, the rows it touches, a type
 * change; without one, its args in readable form), then Approve or Deny. Deny can carry a reason, which goes back to
 * whoever called it. How long to remember the answer is offered only where it may be remembered.
 *
 * `bounded` (the chat's tray, which caps the card's height) keeps the title and the buttons in sight and never scrolls
 * inside the scrolling chat: a body taller than the room left is cut with a fade, and Approve gives way to Review,
 * which shows the whole of it in a dialog (its only scroll) with the answer under it. Nothing is approved unseen.
 */
import type { ApprovalPreview as Preview, Json, QualifiedName, Remember } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ArgList from '../../chat/components/ArgList.vue';
import { fnLabel } from '../../chat/logic/labels.ts';
import { UiDialog, UiIcon, useClipped } from '../../ui/index.ts';
import ApprovalAnswer from './ApprovalAnswer.vue';
import ApprovalPreview from './ApprovalPreview.vue';

const props = withDefaults(defineProps<{
  fn: QualifiedName;
  description: string;
  args: Json | undefined;
  preview?: Preview | undefined;
  /** Whether "this chat" and "always" are offered; otherwise every answer is for this run only. */
  rememberable?: boolean;
  /** Changes when another approval takes the card, which clears a half-typed reason. */
  ident?: string;
  /** The card's height is capped by where it sits: a body taller than the room left is cut, and shown whole on Review. */
  bounded?: boolean;
}>(), { preview: undefined, rememberable: true, ident: '', bounded: false });
const emit = defineEmits<{ decide: [approve: boolean, remember: Remember, reason: string] }>();
defineSlots<{ badge?: () => unknown; after?: () => unknown; buttons?: (scope: { remember: Remember }) => unknown }>();

const remember = ref<Remember>('once');
const reviewing = ref(false);
const body = ref<HTMLElement | null>(null);
const cut = useClipped(body);
const clipped = computed(() => props.bounded && cut.value);
const title = computed(() => props.preview?.title ?? `Allow ${fnLabel(props.fn)}?`);
// the preview's title already says what the fn does, so its label isn't repeated under it
const subtitle = computed(() => props.description);
const irreversible = computed(() => props.preview?.irreversible === true);

watch(() => props.ident, () => { remember.value = 'once'; reviewing.value = false; });

function decide(approve: boolean, answer: Remember, reason: string): void {
  reviewing.value = false;
  emit('decide', approve, answer, reason);
}
</script>

<template>
  <section class="approval" :class="{ bounded }" role="region" aria-label="Approval needed" data-testid="approval-card">
    <header class="head">
      <span class="icon" :class="{ danger: irreversible }"><UiIcon name="shield" :size="16" /></span>
      <div class="titles">
        <h3 class="title">{{ title }}</h3>
        <p v-if="subtitle !== ''" class="description">{{ subtitle }}</p>
      </div>
      <slot name="badge" />
    </header>
    <div ref="body" class="body" :class="{ clipped }" :inert="clipped || undefined" data-testid="approval-body">
      <ApprovalPreview v-if="preview" :preview="preview" />
      <ArgList v-else :args="args" />
    </div>
    <slot name="after" />
    <ApprovalAnswer v-model:remember="remember" :rememberable="rememberable" :irreversible="irreversible" :ident="ident" :review="clipped" @decide="decide" @review="reviewing = true">
      <template #buttons="scope"><slot name="buttons" :remember="scope.remember" /></template>
    </ApprovalAnswer>

    <UiDialog v-if="bounded" v-model:open="reviewing" :title="title" :description="subtitle" width="760px">
      <div data-testid="approval-review">
        <ApprovalPreview v-if="preview" :preview="preview" />
        <ArgList v-else :args="args" />
      </div>
      <template #footer>
        <ApprovalAnswer v-model:remember="remember" :rememberable="rememberable" :irreversible="irreversible" :ident="ident" @decide="decide" />
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.approval {
  display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--warn); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 0 0 3px var(--warn-soft);
}
.approval.bounded { display: flex; flex-direction: column; overflow: hidden; }
.approval.bounded > * { flex: none; }
.approval.bounded > .body { flex: 0 1 auto; overflow: hidden; }
.body { display: grid; align-content: start; gap: var(--space-2); min-width: 0; min-height: 0; }
.body.clipped { mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent); }
.head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.icon.danger { background: var(--danger-soft); color: var(--danger); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
