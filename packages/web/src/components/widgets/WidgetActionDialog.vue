<script setup lang="ts">
/**
 * A row's actions (actions-confirm "form, then confirm"): the list to choose from, with what each does; the picked
 * one's form for the args left after binding; then, for anything above a read (or one the widget asks for), a confirm
 * naming the row. Nothing runs until a person clicks.
 */
import type { Json, WidgetActionOption } from '@harness/core';
import { computed } from 'vue';
import GinForm from '../../gin/GinForm.vue';
import { UiButton, UiDialog } from '../../ui/index.ts';
import type { ActionStep } from './widget-state.ts';
import { ACTION_MODE_WORDS, confirmText } from './widgets.ts';

const props = defineProps<{
  offered: readonly WidgetActionOption[];
  picked: WidgetActionOption | undefined;
  step: ActionStep;
  /** The row's name. */
  row: string | undefined;
  busy: boolean;
  problem: string;
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ choose: [option: WidgetActionOption]; form: [value: Json]; run: [] }>();

const title = computed(() => props.picked?.label ?? (props.row === undefined ? 'Actions' : `Actions for “${props.row}”`));
</script>

<template>
  <UiDialog v-model:open="open" :title="title" :role="step === 'confirm' ? 'alertdialog' : 'dialog'" width="420px">
    <div class="action" data-testid="widget-action">
      <ul v-if="step === 'choose'" class="choices">
        <li v-for="option in offered" :key="option.fn">
          <button type="button" class="choice" :data-fn="option.fn" data-testid="widget-action-choice" @click="emit('choose', option)">
            <span>{{ option.label }}</span>
            <span v-if="ACTION_MODE_WORDS[option.mode] !== ''" class="mode">{{ ACTION_MODE_WORDS[option.mode] }}</span>
          </button>
        </li>
      </ul>
      <GinForm
        v-else-if="step === 'form' && picked?.form" :type="picked.form" :submit-label="picked.confirm ? 'Next' : picked.label" :busy="busy"
        @submit="emit('form', $event)" @cancel="open = false"
      />
      <p v-else-if="picked" class="confirm" data-testid="widget-action-confirm">{{ confirmText(picked, row) }}</p>
      <p v-if="problem !== ''" class="problem" role="alert">{{ problem }}</p>
    </div>
    <template v-if="step === 'confirm'" #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton :variant="picked?.mode === 'delete' ? 'danger' : 'primary'" :loading="busy" data-testid="widget-action-run" @click="emit('run')">
        {{ picked?.label }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.action { display: grid; gap: var(--space-3); }
.choices { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.choice {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); width: 100%; min-height: 40px; padding: 0 var(--space-3);
  border: 0; border-radius: var(--radius); background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer;
}
.choice:hover { background: var(--surface-2); }
.choice:focus-visible { outline: none; box-shadow: inset var(--ring); }
.mode { color: var(--text-faint); font-size: var(--text-xs); }
.confirm { margin: 0; color: var(--text-dim); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
