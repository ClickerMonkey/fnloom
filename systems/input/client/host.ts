/**
 * What the input renderer needs from the chat beyond `system`, provided under global symbols (like the SDK's
 * `RESOURCE_VIEWER`), so this separately built bundle and the chat agree on them:
 *
 * - `INPUT_ANSWERS`: sends the person's answers as a user message with one `input-answer` part (which the chat hides
 *   and the model reads in `<input-answer>` tags), and says whether a run's form was answered already.
 * - `VALUE_EDITOR`: the chat's gin value editor, used for a form when it is there.
 * - `ACCESS_INFO`: whether the hub has more than one person, so the save step offers who may use the form.
 *
 * Without them the renderer still draws the form with its own fields, and says it can't send the answers.
 */
import type { AccessInfo, Json, MessagePart, RunId } from '@harness/core';
import type { TypeDef } from '@aeye/gin';
import type { Component, InjectionKey } from 'vue';

/** An answer as it was sent: the run's `input-answer` part, without its type tag. */
export type InputAnswer = Omit<Extract<MessagePart, { type: 'input-answer' }>, 'type'>;

/** Sending answers, and the answers already sent. */
export interface InputAnswers {
  /** Add a user message whose only part is this `input-answer`. */
  send(answer: InputAnswer): Promise<void>;
  /** The answer sent for a run's form, if one was (read reactively). */
  answerOf(run: RunId): InputAnswer | undefined;
}

/** The props of the chat's gin value editor. */
export interface ValueEditorProps {
  type: TypeDef;
  modelValue: Json | undefined;
  readonly?: boolean;
}

/** The answers service. */
export const INPUT_ANSWERS: InjectionKey<InputAnswers> = Symbol.for('harness.inputAnswers');
/** The chat's gin value editor (`v-model` over the JSON value). */
export const VALUE_EDITOR: InjectionKey<Component<ValueEditorProps>> = Symbol.for('harness.valueEditor');
/** Whether the hub has more than one person (a reactive getter). */
export const ACCESS_INFO: InjectionKey<Readonly<AccessInfo>> = Symbol.for('harness.accessInfo');
