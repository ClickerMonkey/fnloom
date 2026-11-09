/**
 * The answers service a system's form renderer reads from the chat (the SDK's `INPUT_ANSWERS`): answers go out as
 * hidden user messages and are read back from the thread's messages. The SDK's client declares the keys.
 */
import type { InputAnswers } from '@harness/sdk';
import { computed } from 'vue';
import { inputAnswers } from '../logic/thread.ts';
import type { ThreadStore } from './thread.ts';

export { ACCESS_INFO, INPUT_ANSWERS, VALUE_EDITOR, type InputAnswer, type InputAnswers, type ValueEditorProps } from '@harness/sdk';

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
