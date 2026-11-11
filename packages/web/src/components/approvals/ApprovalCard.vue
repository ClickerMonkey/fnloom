<script setup lang="ts">
/**
 * One run waiting for approval, wherever it is answered (above the chat's composer, in the inbox): what it is — the
 * preview's one line, or "Allow <fn>?" — and what it will do (the system's preview: SQL, the rows it touches, a type
 * change; without one, its args in readable form), then Approve or Deny. Deny can carry a reason, which goes back to
 * whoever called it. How long to remember the answer is offered only where it may be remembered. `bounded` (the chat's
 * tray, which caps the card's height) keeps the title and the buttons in sight and scrolls only the body.
 */
import type { ApprovalPreview as Preview, Json, QualifiedName, Remember } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ArgList from '../../chat/components/ArgList.vue';
import { fnLabel } from '../../chat/logic/labels.ts';
import { UiButton, UiIcon, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';
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
  /** The card's height is capped by where it sits: only its body scrolls, the buttons stay in sight. */
  bounded?: boolean;
}>(), { preview: undefined, rememberable: true, ident: '', bounded: false });
const emit = defineEmits<{ decide: [approve: boolean, remember: Remember, reason: string] }>();
defineSlots<{ badge?: () => unknown; after?: () => unknown; buttons?: (scope: { remember: Remember }) => unknown }>();

const REMEMBER: readonly SegmentOption<Remember>[] = [{ value: 'once', label: 'Once' }, { value: 'session', label: 'This chat' }, { value: 'always', label: 'Always' }];

const remember = ref<Remember>('once');
const denying = ref(false);
const reason = ref('');
const title = computed(() => props.preview?.title ?? `Allow ${fnLabel(props.fn)}?`);
// the preview's title already says what the fn does, so its label isn't repeated under it
const subtitle = computed(() => props.description);

watch(() => props.ident, () => { denying.value = false; reason.value = ''; });

function decide(approve: boolean): void {
  emit('decide', approve, props.rememberable ? remember.value : 'once', approve ? '' : reason.value.trim());
}
</script>

<template>
  <section class="approval" :class="{ bounded }" role="region" aria-label="Approval needed" data-testid="approval-card">
    <header class="head">
      <span class="icon" :class="{ danger: preview?.irreversible }"><UiIcon name="shield" :size="16" /></span>
      <div class="titles">
        <h3 class="title">{{ title }}</h3>
        <p v-if="subtitle !== ''" class="description">{{ subtitle }}</p>
      </div>
      <slot name="badge" />
    </header>
    <div class="body" :tabindex="bounded ? 0 : undefined" data-testid="approval-body">
      <ApprovalPreview v-if="preview" :preview="preview" :fill="bounded" />
      <ArgList v-else :args="args" />
    </div>
    <slot name="after" />
    <UiInput v-if="denying" v-model="reason" label="Why not? (optional)" placeholder="Tell the agent what to do instead" size="sm" autofocus @enter="decide(false)" />
    <footer class="foot">
      <UiSegmented v-if="rememberable" v-model="remember" :options="REMEMBER" label="Remember this answer" />
      <div class="buttons">
        <slot name="buttons" :remember="remember" />
        <UiButton v-if="!denying" size="sm" variant="secondary" data-testid="deny" @click="denying = true">Deny</UiButton>
        <UiButton v-else size="sm" variant="danger" data-testid="deny-confirm" @click="decide(false)">Deny</UiButton>
        <UiButton size="sm" :variant="preview?.irreversible ? 'danger' : 'primary'" icon="check" data-testid="approve" @click="decide(true)">Approve</UiButton>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.approval {
  display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-3) var(--space-4);
  border: 1px solid var(--warn); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 0 0 3px var(--warn-soft);
}
.approval.bounded { display: flex; flex-direction: column; overflow: hidden; }
.approval.bounded > * { flex: none; }
.approval.bounded > .body { flex: 0 1 auto; }
.body { display: grid; gap: var(--space-2); min-width: 0; min-height: 0; }
.bounded .body { overflow-y: auto; overscroll-behavior: contain; margin-right: calc(-1 * var(--space-2)); padding-right: var(--space-2); }
.body:focus-visible { outline: none; box-shadow: var(--ring); }
.head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.icon.danger { background: var(--danger-soft); color: var(--danger); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); margin-left: auto; }
</style>
