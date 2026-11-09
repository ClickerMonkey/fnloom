/**
 * What the input renderer needs from the chat beyond `system`, from the SDK's client (global symbols, like
 * `RESOURCE_VIEWER`, so this separately built bundle and the chat agree on them):
 *
 * - `INPUT_ANSWERS`: sends the person's answers as a user message with one `input-answer` part (which the chat hides
 *   and the model reads in `<input-answer>` tags), and says whether a run's form was answered already.
 * - `VALUE_EDITOR`: the chat's gin value editor, used for a form when it is there.
 * - `ACCESS_INFO`: whether the hub has more than one person, so the save step offers who may use the form.
 * - `SHARE_EDITOR`: the app's visibility editor (with its people-and-groups picker), which that step draws.
 *
 * Without them the renderer still draws the form with its own fields, and says it can't send the answers.
 */
export { ACCESS_INFO, INPUT_ANSWERS, SHARE_EDITOR, VALUE_EDITOR, type InputAnswer, type InputAnswers, type ShareEditorProps, type ValueEditorProps } from '@harness/sdk';
