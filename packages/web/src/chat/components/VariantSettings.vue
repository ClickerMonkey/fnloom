<script setup lang="ts">
/**
 * One variant of an A/B compare being set up: its name and what it changes of the chat's settings, each edited with
 * the chat's own picker (the model picker, the agent and fn mode menus' choices, the chat mode and contextor settings)
 * and the system prompt. A setting left alone is the chat's; every changed one shows as a chip and can be put back.
 */
import type { ChatCapabilities, ChatFnMode, CompareSettings, QualifiedName, Session, SystemName } from '@harness/core';
import { computed, ref } from 'vue';
import { UiBadge, UiIcon, UiIconButton, UiInput, UiSelect, UiSwitch, UiTextarea, type SelectOption } from '../../ui/index.ts';
import { setSetting, setSystem, settingsWords, variantLetter, variantSystems, type VariantDraft } from '../logic/compare.ts';
import { agentOptions, modelChoiceOf, modelLabel, modelPick, type ModelPick } from '../logic/session.ts';
import { contextorFrom, CONTEXTOR_CHOICES, defaultContextor, defaultMode, FN_MODE_CHOICES, FN_MODE_WORDS, DEFAULT_FN_MODE, MODE_CHOICES, modeFrom } from '../logic/modes.ts';
import ChatModeSettings from './ChatModeSettings.vue';
import ModelPicker from './ModelPicker.vue';

const props = defineProps<{
  index: number;
  draft: VariantDraft;
  /** The chat's own settings, which a variant starts from. */
  session: Pick<Session, keyof CompareSettings>;
  models: ChatCapabilities['models'];
  agents: ChatCapabilities['agents'];
  /** The hub's systems, which a variant may use more or fewer of than the chat. */
  systems: ChatCapabilities['systems'];
  /** Whether it can be taken away (more than the fewest variants). */
  removable: boolean;
  /** Its changes repeat another variant's. */
  repeated: boolean;
}>();
const emit = defineEmits<{ update: [draft: VariantDraft]; remove: [] }>();

/** The chat's own value, in a picker: the setting left alone. */
const CHATS = 'chat';

const picking = ref(false);
const s = computed(() => props.draft.settings);
const words = computed(() => settingsWords(s.value, props.models));
const letter = computed(() => variantLetter(props.index));
const placeholder = computed(() => (words.value.length === 0 ? `Variant ${letter.value} (this chat)` : words.value.join(' · ')));

function set<K extends keyof CompareSettings>(key: K, value: CompareSettings[K] | undefined): void {
  emit('update', setSetting(props.draft, key, value));
}

const modelNow = computed(() => modelLabel(s.value.model ?? props.session.model, props.models));
function pickModel(pick: ModelPick): void {
  set('model', modelChoiceOf(pick) ?? undefined);
  picking.value = false;
}

const agentChoices = computed<SelectOption<QualifiedName | typeof CHATS>[]>(() => [
  { value: CHATS, label: `This chat’s (${agentOptions(props.agents, props.session.agent)[0]?.name ?? props.session.agent})` },
  ...agentOptions(props.agents, props.session.agent).filter((a) => a.fn !== props.session.agent).map((a) => ({ value: a.fn, label: a.name })),
]);
const fnModeChoices = computed<SelectOption<ChatFnMode | typeof CHATS>[]>(() => [
  { value: CHATS, label: `This chat’s (${FN_MODE_WORDS[props.session.fnMode ?? DEFAULT_FN_MODE].label})` },
  ...FN_MODE_CHOICES.map((mode) => ({ value: mode, label: FN_MODE_WORDS[mode].label })),
]);

const names = computed(() => props.systems.map((system) => system.name));
const enabled = computed(() => variantSystems(props.draft, props.session, names.value));
function toggleSystem(name: SystemName, on: boolean): void {
  emit('update', setSystem(props.draft, props.session, names.value, name, on));
}
</script>

<template>
  <section class="variant" :class="{ repeated }" :data-testid="`variant-settings-${index}`" :aria-label="`Variant ${letter}`">
    <header class="head">
      <span class="letter" aria-hidden="true">{{ letter }}</span>
      <UiInput :model-value="draft.label" :label="`Variant ${letter} name`" hide-label :placeholder="placeholder" :data-testid="`variant-label-${index}`" @update:model-value="emit('update', { ...draft, label: $event })" />
      <UiIconButton v-if="removable" size="sm" icon="x" :label="`Remove variant ${letter}`" :data-testid="`variant-remove-${index}`" @click="emit('remove')" />
    </header>
    <p v-if="words.length === 0" class="dim">Answers as this chat does now. Change anything below.</p>
    <ul v-else class="chips" aria-label="What it changes">
      <li v-for="word in words" :key="word"><UiBadge tone="accent">{{ word }}</UiBadge></li>
    </ul>
    <p v-if="repeated" class="warn"><UiIcon name="warning" :size="14" /> Same as another variant: change something to compare.</p>

    <div class="field">
      <span class="name">Model</span>
      <button type="button" class="model" :aria-expanded="picking ? 'true' : 'false'" :data-testid="`variant-model-${index}`" @click="picking = !picking">
        <UiIcon name="cpu" :size="14" /><span class="text">{{ modelNow }}</span><UiIcon :name="picking ? 'chevron-up' : 'chevron-down'" :size="12" />
      </button>
      <ModelPicker v-if="picking" class="picker" :models="models" :current="modelPick(s.model)" list-height="240px" @pick="pickModel" />
    </div>
    <UiSelect
      size="sm" label="Agent" :options="agentChoices" :model-value="s.agent ?? CHATS" :data-testid="`variant-agent-${index}`"
      @update:model-value="set('agent', $event === CHATS ? undefined : $event)"
    />
    <UiSelect
      size="sm" label="Fns it may use" :options="fnModeChoices" :model-value="s.fnMode ?? CHATS" :data-testid="`variant-fn-mode-${index}`"
      @update:model-value="set('fnMode', $event === CHATS ? undefined : $event)"
    />
    <ChatModeSettings
      label="Chat mode" :value="s.mode ?? session.mode" :choices="MODE_CHOICES" :defaults="defaultMode" :read="modeFrom" :testid="`variant-mode-${index}`"
      @change="set('mode', $event ?? undefined)"
    />
    <ChatModeSettings
      label="Contextor" :value="s.contextor ?? session.contextor" :choices="CONTEXTOR_CHOICES" :defaults="defaultContextor" :read="contextorFrom" :testid="`variant-contextor-${index}`"
      @change="set('contextor', $event ?? undefined)"
    />
    <UiTextarea
      label="System prompt" :rows="2" :max-rows="8" :model-value="s.instructions ?? ''" :placeholder="session.instructions ?? 'The agent’s own instructions'" :data-testid="`variant-prompt-${index}`"
      @update:model-value="set('instructions', $event.trim() === '' ? undefined : $event)"
    />
    <UiSwitch
      :model-value="s.citations ?? session.citations === true" label="Use citations" :data-testid="`variant-citations-${index}`"
      @update:model-value="set('citations', $event === (session.citations === true) ? undefined : $event)"
    />
    <div v-if="systems.length > 0" class="field" role="group" :aria-label="`Variant ${letter} systems`">
      <span class="name">Systems</span>
      <ul class="systems">
        <li v-for="system in systems" :key="system.name" class="system">
          <span class="system-name">{{ system.name }}</span>
          <UiSwitch
            :model-value="enabled.has(system.name)" :label="`Variant ${letter} uses ${system.name}`" hide-label :disabled="!system.enabled"
            :data-testid="`variant-system-${index}-${system.name}`" @update:model-value="toggleSystem(system.name, $event)"
          />
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.variant {
  display: grid; gap: var(--space-3); align-content: start; min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface-raised, var(--surface)); transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.variant:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.variant.repeated { border-color: var(--warn); }
.head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); }
.letter {
  display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-full); background: var(--accent); color: var(--on-accent);
  font-weight: 700; font-size: var(--text-sm);
}
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.warn { display: flex; align-items: center; gap: var(--space-1); margin: 0; color: var(--warn); font-size: var(--text-sm); }
.field { display: grid; gap: var(--space-1); min-width: 0; }
.name { font-size: var(--text-sm); font-weight: 600; }
.model {
  display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.model:hover { border-color: var(--border-strong, var(--accent)); }
.model .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker { margin-top: var(--space-1); }
.systems { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.system { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.system-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
</style>
