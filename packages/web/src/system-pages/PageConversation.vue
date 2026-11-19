<script setup lang="ts">
/**
 * A system page's conversation (`components.Conversation`, item 8), drawn with the chat's own parts: the person's
 * messages as the chat's bubbles, each answer as the chat's answer (markdown words, reasoning folded where it
 * happened, each call a run card, a stretch of calls folded into one section), and notes as the chat's notes. A run
 * card opens and closes in place (there is no run drawer outside a chat).
 */
import type { ConversationProps } from '@harness/sdk';
import { computed, ref } from 'vue';
import AssistantAnswer from '../chat/components/AssistantAnswer.vue';
import NoteRow from '../chat/components/NoteRow.vue';
import UserMessage from '../chat/components/UserMessage.vue';
import type { RunView } from '../chat/logic/runs.ts';
import { useStores } from '../state/stores.ts';
import { useNow } from '../ui/now.ts';
import { conversationItems, PAGE_AGENT } from './conversation.ts';

const props = withDefaults(defineProps<ConversationProps>(), { streaming: false });

const { session } = useStores();
const now = useNow();
const me = computed(() => session.user.value?.id ?? PAGE_AGENT);
const items = computed(() => conversationItems(props.entries, { system: props.system, me: me.value, streaming: props.streaming }));
const NO_SUGGESTIONS = { context: [], fns: [] } as const;

/** The run cards opened, by run id: cards start folded to their line. */
const opened = ref<ReadonlySet<string>>(new Set());
const collapsed = (run: RunView): boolean => !opened.value.has(run.id);
/** Open or fold one card (its line was clicked). */
function toggle(id: string): void { setOpen([id], !opened.value.has(id)); }
function setOpen(ids: readonly string[], open: boolean): void {
  const next = new Set(opened.value);
  for (const id of ids) { if (open) { next.add(id); } else { next.delete(id); } }
  opened.value = next;
}
</script>

<template>
  <div class="conversation" data-testid="conversation">
    <template v-for="item in items" :key="item.key">
      <UserMessage
        v-if="item.kind === 'user'" :message="item.message" mine :author-name="session.user.value?.name ?? 'You'" :now="now"
        :command-name="(name) => name" :suggestions="NO_SUGGESTIONS" :actions="[]"
      />
      <NoteRow v-else-if="item.kind === 'note'" :message="item.message" />
      <AssistantAnswer
        v-else :messages="[item.message]" :author-name="agent" :now="now" :streaming="item.message.status === 'streaming'" :failed="false"
        :runs-of="() => item.runs" :live-of="() => item.segments" :collapsed="collapsed" :view-of="() => undefined" :attachment-view="() => undefined" :actions="[]"
        @run-open="toggle($event)"
        @run-toggle="(id, c) => setOpen([id], !c)" @collapse-all="(c) => setOpen(item.runs.map((run) => run.id), !c)"
      />
    </template>
  </div>
</template>

<style scoped>
.conversation { display: grid; gap: var(--space-4); min-width: 0; }
</style>
