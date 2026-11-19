<script setup lang="ts">
/**
 * One variant of an A/B compare: its name, what it changes, how it stands, what it spent of its share, its tokens and
 * time, the approvals it waits on (each card says which variant asks), its answer as it streams (text, reasoning and
 * the fns it called, each fn a pill), and Use this. A discarded variant lists what it already did, which stays done.
 */
import type { ApprovalId, ChatCapabilities, CompareEffect, CompareVariantView, Json, MessageId, Remember, VariantIndex } from '@harness/core';
import { computed, ref } from 'vue';
import ApprovalCard from '../../components/approvals/ApprovalCard.vue';
import FnPill from '../../fns/components/FnPill.vue';
import { useFnNotice } from '../../fns/state/fn-notices.ts';
import { UiBadge, UiButton, UiIcon, UiMarkdown, UiSwitch } from '../../ui/index.ts';
import { answerBlocks, choosable, settingsWords, variantLetter, variantStats, variantStatus } from '../logic/compare.ts';
import type { StreamedText } from '../state/compare.ts';
import ReasoningBlock from './ReasoningBlock.vue';

const props = withDefaults(defineProps<{
  variant: CompareVariantView;
  chosen: VariantIndex | undefined;
  reserved: number;
  models: ChatCapabilities['models'];
  streamed: ReadonlyMap<MessageId, StreamedText>;
  /** What it already did, when it was discarded. */
  effects?: readonly CompareEffect[];
  choosing?: boolean;
}>(), { effects: () => [], choosing: false });
const emit = defineEmits<{ choose: [adopt: boolean]; decide: [id: ApprovalId, approve: boolean, remember: Remember, reason: string, answer: Json | undefined] }>();

const noticeOf = useFnNotice();
const adopt = ref(false);
const openReasoning = ref<ReadonlySet<number>>(new Set());
const letter = computed(() => variantLetter(props.variant.variant));
const status = computed(() => variantStatus(props.variant, props.chosen, props.variant.variant));
const stats = computed(() => variantStats(props.variant, props.reserved));
const words = computed(() => settingsWords(props.variant.settings, props.models));
const blocks = computed(() => answerBlocks(props.variant.messages, props.streamed));
const canChoose = computed(() => choosable({ chosen: props.chosen }, props.variant));

function toggle(at: number, open: boolean): void {
  const next = new Set(openReasoning.value);
  if (open) { next.add(at); } else { next.delete(at); }
  openReasoning.value = next;
}
</script>

<template>
  <article class="column" :class="{ chosen: chosen === variant.variant, discarded: chosen !== undefined && chosen !== variant.variant }" :data-testid="`compare-column-${variant.variant}`">
    <header class="head">
      <span class="letter" aria-hidden="true">{{ letter }}</span>
      <div class="names">
        <h3 :title="variant.label">{{ variant.label }}</h3>
        <ul v-if="words.length > 0" class="chips" aria-label="What it changes"><li v-for="word in words" :key="word">{{ word }}</li></ul>
        <p v-else class="dim">As the chat answers now</p>
      </div>
      <UiBadge :tone="status.tone" dot :live="status.live">{{ status.label }}</UiBadge>
    </header>
    <dl class="stats">
      <div :title="`Spent ${stats.cost} reserved for it`"><dt><UiIcon name="coins" :size="12" />Cost</dt><dd>{{ stats.cost }}</dd></div>
      <div><dt><UiIcon name="hash" :size="12" />Tokens</dt><dd>{{ stats.tokens }}</dd></div>
      <div><dt><UiIcon name="clock" :size="12" />Time</dt><dd>{{ stats.time }}</dd></div>
      <span class="meter" role="meter" :aria-valuenow="Math.round(stats.share * 100)" aria-valuemin="0" aria-valuemax="100" aria-label="Share of its budget spent">
        <span :style="{ width: `${stats.share * 100}%` }" />
      </span>
    </dl>
    <div class="answer">
      <ApprovalCard
        v-for="approval in variant.approvals" :key="approval.id" class="approval" :ident="approval.id" :fn="approval.fn" :description="approval.preview?.title ?? ''" :args="undefined"
        :preview="approval.preview" :rememberable="false" :notice="noticeOf(approval.fn)" :ask="approval.ask" @decide="(approve, remember, reason, answer) => emit('decide', approval.id, approve, remember, reason, answer)"
      >
        <template #badge><UiBadge tone="warn">Variant {{ letter }} asks</UiBadge></template>
      </ApprovalCard>
      <template v-for="(block, at) in blocks" :key="at">
        <ReasoningBlock v-if="block.kind === 'reasoning'" :text="block.text" :thinking="status.live && at === blocks.length - 1" :open="openReasoning.has(at)" @update:open="toggle(at, $event)" />
        <UiMarkdown v-else-if="block.kind === 'text'" class="text" :source="block.text" />
        <div v-else class="call"><UiIcon name="fn" :size="12" /><FnPill :name="block.fn" /></div>
      </template>
      <p v-if="blocks.length === 0 && variant.approvals.length === 0" class="dim waiting">
        <template v-if="status.live">Thinking…</template>
        <template v-else>No answer.</template>
      </p>
      <section v-if="effects.length > 0" class="effects" aria-label="What it already did">
        <p><UiIcon name="warning" :size="14" /> Already done, and kept:</p>
        <ul><li v-for="effect in effects" :key="effect.run"><FnPill :name="effect.fn" /></li></ul>
      </section>
    </div>
    <footer v-if="chosen === undefined" class="foot">
      <UiSwitch v-model="adopt" label="Keep its settings" description="Make its settings this chat’s own" :disabled="!canChoose" />
      <UiButton variant="primary" icon="check" :disabled="!canChoose" :loading="choosing" :data-testid="`compare-use-${variant.variant}`" @click="emit('choose', adopt)">Use this</UiButton>
    </footer>
    <footer v-else-if="chosen === variant.variant" class="foot picked"><UiIcon name="success" :size="16" /> In the chat now</footer>
  </article>
</template>

<style scoped>
.column {
  display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface); overflow: hidden; transition: border-color var(--medium) var(--ease), opacity var(--medium) var(--ease), box-shadow var(--medium) var(--ease);
}
.column.chosen { border-color: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.column.discarded { opacity: 0.72; }
.head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-2); align-items: start; padding: var(--space-3); border-bottom: 1px solid var(--border); }
.letter {
  display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-full); background: var(--accent); color: var(--on-accent); font-weight: 700; font-size: var(--text-sm);
}
.chosen .letter { background: var(--ok); }
.names { min-width: 0; }
h3 { margin: 0; font-size: var(--text-base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips { display: flex; flex-wrap: wrap; gap: 2px var(--space-2); margin: 2px 0 0; padding: 0; list-style: none; color: var(--text-dim); font-size: var(--text-xs); }
.chips li + li::before { content: '·'; margin-right: var(--space-2); color: var(--text-faint); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.stats { position: relative; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0; padding: var(--space-2) var(--space-3) var(--space-3); font-size: var(--text-sm); }
.stats div { display: grid; }
dt { display: flex; align-items: center; gap: 4px; color: var(--text-faint); font-size: var(--text-xs); }
dd { margin: 0; font-variant-numeric: tabular-nums; }
.meter { position: absolute; left: var(--space-3); right: var(--space-3); bottom: var(--space-1); height: 3px; border-radius: var(--radius-full); background: var(--border); overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--accent); transition: width var(--slow) var(--ease); }
.answer { display: grid; gap: var(--space-3); align-content: start; min-height: 0; overflow: auto; padding: var(--space-3); border-top: 1px solid var(--border); }
.text { min-width: 0; overflow-wrap: anywhere; }
.call { display: flex; align-items: center; gap: var(--space-1); color: var(--text-faint); }
.waiting { padding: var(--space-4) 0; text-align: center; }
.effects { padding: var(--space-2); border-radius: var(--radius-md); background: color-mix(in srgb, var(--warn) 10%, transparent); font-size: var(--text-sm); }
.effects p { display: flex; align-items: center; gap: var(--space-1); margin: 0 0 var(--space-1); }
.effects ul { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-3); border-top: 1px solid var(--border); }
.foot.picked { justify-content: flex-start; color: var(--ok); font-weight: 600; }
</style>
