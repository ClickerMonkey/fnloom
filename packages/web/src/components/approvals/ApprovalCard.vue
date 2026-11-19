<script setup lang="ts">
/**
 * One run waiting for approval, wherever it is answered (above the chat's composer, in the inbox): what it is — the
 * preview's one line (its fn a `FnPill` beside it), or "Allow <fn>?" with the fn a `FnPill` — and what it will do (the system's preview: SQL, the rows it touches, a type
 * change; without one, its args in readable form), then Approve or Deny. Deny can carry a reason, which goes back to
 * whoever called it. How long to remember the answer is offered only where it may be remembered.
 *
 * `bounded` (the chat's tray, which caps the card's height) keeps the title and the buttons in sight and never scrolls
 * inside the scrolling chat: a body taller than the room left is cut with a fade, and Approve gives way to Review,
 * which shows the whole of it in a dialog (its only scroll) with the answer under it. Nothing is approved unseen. The
 * sensitive files it touches are never cut: they sit under the body in short form, every one in sight, and on a phone
 * the body (a command, say) is held to a few lines so the chat above keeps its room.
 *
 * A proposal that asks for something (`ask`, build 9: a question Claude waits on) shows its form under the body, never
 * cut; Approve waits until the form's value fits, and the value goes with the answer.
 */
import type { ApprovalPreview as Preview, Json, ProposalAsk, QualifiedName, Remember, SensitivityFlag } from '@harness/core';
import { computed, ref, shallowRef, watch } from 'vue';
import ArgList from '../../chat/components/ArgList.vue';
import { fnLabel } from '../../chat/logic/labels.ts';
import FnPill from '../../fns/components/FnPill.vue';
import { UiDialog, UiIcon, useClipped } from '../../ui/index.ts';
import ApprovalAnswer from './ApprovalAnswer.vue';
import ApprovalAsk from './ApprovalAsk.vue';
import ApprovalPreview from './ApprovalPreview.vue';
import SensitiveFiles from './SensitiveFiles.vue';

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
  /** Its fn's notice ("This usually takes about 3 minutes."), so the person knows before approving. */
  notice?: string;
  /** The form the approver fills (a proposal's `ask`); its value is sent with Approve. */
  ask?: ProposalAsk | undefined;
}>(), { preview: undefined, rememberable: true, ident: '', bounded: false, notice: '', ask: undefined });
/** `answer` is the filled form when the card asks for one (undefined otherwise, and on Deny). */
const emit = defineEmits<{ decide: [approve: boolean, remember: Remember, reason: string, answer: Json | undefined] }>();
defineSlots<{ badge?: () => unknown; after?: () => unknown; buttons?: (scope: { remember: Remember }) => unknown }>();

const remember = ref<Remember>('once');
const reviewing = ref(false);
/** The form's value while it fits; undefined while it doesn't (or there is no form). */
const answer = shallowRef<Json | undefined>(undefined);
/** An optional form (an "always allow" tick) may be left as it is; Approve waits for any other form to fit. */
const optional = computed(() => props.ask?.type.name === 'optional');
const blocked = computed(() => props.ask !== undefined && !optional.value && answer.value === undefined);
const approveLabel = computed(() => (props.ask === undefined || optional.value ? 'Approve' : 'Answer'));
/** A question is skipped, not denied. */
const denyLabel = computed(() => (approveLabel.value === 'Answer' ? 'Skip' : 'Deny'));
const body = ref<HTMLElement | null>(null);
const cut = useClipped(body);
const clipped = computed(() => props.bounded && cut.value);
const title = computed(() => props.preview?.title ?? `Allow ${fnLabel(props.fn)}?`);
// the preview's title already says what the fn does, so its label isn't repeated under it
const subtitle = computed(() => props.description);
const irreversible = computed(() => props.preview?.irreversible === true);
/** A call that touches sensitive files is asked about every time: its answer is never remembered. */
const canRemember = computed(() => props.rememberable && props.preview?.parts.some((part) => part.type === 'flags') !== true);
/** In the tray the flagged files are taken out of the body, so its cut never hides one. */
const trayFlags = computed((): readonly SensitivityFlag[] => (props.bounded ? (props.preview?.parts ?? []).flatMap((part) => (part.type === 'flags' ? part.flags : [])) : []));
const shownPreview = computed((): Preview | undefined => {
  const preview = props.preview;
  if (preview === undefined || trayFlags.value.length === 0) { return preview; }
  return { ...preview, parts: preview.parts.filter((part) => part.type !== 'flags') };
});

watch(() => props.ident, () => { remember.value = 'once'; reviewing.value = false; });

function decide(approve: boolean, remembered: Remember, reason: string): void {
  if (approve && blocked.value) { return; }
  reviewing.value = false;
  emit('decide', approve, remembered, reason, approve && props.ask !== undefined ? answer.value : undefined);
}
</script>

<template>
  <section class="approval" :class="{ bounded }" role="region" aria-label="Approval needed" data-testid="approval-card">
    <header class="head">
      <span class="icon" :class="{ danger: irreversible }"><UiIcon name="shield" :size="16" /></span>
      <div class="titles">
        <h3 v-if="preview?.title" class="title">{{ title }}</h3>
        <h3 v-else class="title">Allow <FnPill :name="fn" class="title-fn" />?</h3>
        <p v-if="preview?.title" class="fn-line"><FnPill :name="fn" /></p>
        <p v-if="subtitle !== ''" class="description">{{ subtitle }}</p>
        <p v-if="notice !== ''" class="notice" data-testid="approval-notice"><UiIcon name="clock" :size="13" /><span>{{ notice }}</span></p>
      </div>
      <slot name="badge" />
    </header>
    <div ref="body" class="body" :class="{ clipped }" :inert="clipped || undefined" data-testid="approval-body">
      <ApprovalPreview v-if="shownPreview" :preview="shownPreview" />
      <ArgList v-else :args="args" />
    </div>
    <SensitiveFiles v-if="trayFlags.length > 0" :flags="trayFlags" compact />
    <ApprovalAsk v-if="ask" :type="ask.type" :ident="ident" @change="answer = $event" />
    <slot name="after" />
    <ApprovalAnswer v-model:remember="remember" :rememberable="canRemember" :irreversible="irreversible" :ident="ident" :review="clipped" :blocked="blocked" :approve-label="approveLabel" :deny-label="denyLabel" @decide="decide" @review="reviewing = true">
      <template #buttons="scope"><slot name="buttons" :remember="scope.remember" /></template>
    </ApprovalAnswer>

    <UiDialog v-if="bounded" v-model:open="reviewing" :title="title" :description="subtitle" width="760px">
      <div data-testid="approval-review">
        <ApprovalPreview v-if="preview" :preview="preview" />
        <ArgList v-else :args="args" />
      </div>
      <template #footer>
        <ApprovalAnswer v-model:remember="remember" :rememberable="canRemember" :irreversible="irreversible" :ident="ident" :blocked="blocked" :approve-label="approveLabel" :deny-label="denyLabel" @decide="decide" />
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
@media (max-width: 639.98px) { .approval.bounded > .body { max-height: 6.5em; } }
.body.clipped { mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent); }
.head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius); background: var(--warn-soft); color: var(--warn); }
.icon.danger { background: var(--danger-soft); color: var(--danger); }
.titles { display: grid; gap: 2px; flex: 1; min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.title-fn { font-size: var(--text-sm); vertical-align: 1px; }
.fn-line { margin: 0; }
.notice { display: flex; align-items: center; gap: var(--space-1); margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
</style>
