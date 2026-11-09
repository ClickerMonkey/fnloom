/**
 * What a system's input form renderer reads from the chat, provided under global symbols so a separately built system
 * bundle and the chat agree on them (as `RESOURCE_VIEWER` does): sending a form's answers, the chat's gin value
 * editor, and whether the hub has more than one person. The input system's client (`systems/input/client/host.ts`)
 * declares the same keys and shapes.
 */
import type { Json, RunId } from '@harness/core';
import { computed, type Component, type InjectionKey } from 'vue';
import { inputAnswers, type InputAnswerPart } from '../logic/thread.ts';
import type { ThreadStore } from './thread.ts';

/** An answer as it was sent: the run's `input-answer` part, without its type tag. */
export type InputAnswer = Omit<InputAnswerPart, 'type'>;

/** Sending answers, and the answers already sent. */
export interface InputAnswers {
  /** Add a user message whose only part is this `input-answer`; rejects with the reason when it couldn't be sent. */
  send(answer: InputAnswer): Promise<void>;
  /** The answer sent for a run's form, if one was (read reactively). */
  answerOf(run: RunId): InputAnswer | undefined;
}

/**
 * The props of the chat's gin value editor, as a form renderer binds them. `type` is a gin `TypeDef`; the editor reads
 * any definition (and says when it can't), so it takes `unknown`, which a renderer's `TypeDef` fits.
 */
export interface ValueEditorProps {
  type: unknown;
  modelValue: Json | undefined;
  readonly?: boolean;
}

/** The answers service. */
export const INPUT_ANSWERS: InjectionKey<InputAnswers> = Symbol.for('harness.inputAnswers');
/** The chat's gin value editor (`v-model` over the JSON value). */
export const VALUE_EDITOR: InjectionKey<Component<ValueEditorProps>> = Symbol.for('harness.valueEditor');
/** Whether the hub has more than one person (a reactive getter). */
export const ACCESS_INFO: InjectionKey<{ readonly multiUser: boolean }> = Symbol.for('harness.accessInfo');

/** The answers service over one thread: answers go out as hidden user messages, and are read back from its messages. */
export function threadInputAnswers(thread: Pick<ThreadStore, 'send' | 'messages' | 'problem'>): InputAnswers {
  const sent = computed(() => inputAnswers(thread.messages.value));
  return {
    async send(answer) {
      const ok = await thread.send({ parts: [{ type: 'input-answer', ...answer }] });
      if (!ok) { throw new Error(thread.problem.value === '' ? 'Your answers weren’t sent. Try again.' : thread.problem.value); }
    },
    answerOf(run) {
      const part = sent.value.get(run);
      if (part === undefined) { return undefined; }
      const { type: _type, ...answer } = part;
      return answer;
    },
  };
}
