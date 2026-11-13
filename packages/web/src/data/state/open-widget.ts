/**
 * Opening a saved widget in a new chat (data-home): the chat is made, the widget runs there as the person's run, and
 * the page moves to it, where its chips, pager and row actions work. The Data page's widget list and the fn page share it.
 */
import type { QualifiedName } from '@harness/core';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { links } from '../../app/routes.ts';
import { fnLabel } from '../../chat/logic/labels.ts';
import { useStores } from '../../state/stores.ts';

/** Open widgets in a new chat; `opening` is the widget on its way. */
export function useWidgetOpener() {
  const { chat, toasts } = useStores();
  const router = useRouter();
  const opening = ref('');
  async function open(widget: QualifiedName): Promise<void> {
    opening.value = widget;
    try {
      const session = await chat.sessions.create({ title: fnLabel(widget) });
      if (session === undefined) { toasts.error("Couldn't open the widget", chat.sessions.problem.value); return; }
      await chat.thread(session).invoke(widget, {});
      await router.push(links.session(session));
    } finally {
      opening.value = '';
    }
  }
  return { opening, open };
}
