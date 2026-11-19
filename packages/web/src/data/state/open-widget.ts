/**
 * Opening a saved widget in a new chat (data-home): the chat is made, the widget runs there as the person's run, and
 * the page moves to it, where its chips, pager and row actions work. The fn page uses it; the widgets system's own
 * page does the same through its page host (`host.openChat`).
 */
import type { QualifiedName } from '@harness/core';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { fnLabel } from '../../chat/logic/labels.ts';
import { openChat } from '../../chat/state/open-chat.ts';
import { useStores } from '../../state/stores.ts';

/** Open widgets in a new chat; `opening` is the widget on its way. */
export function useWidgetOpener() {
  const { chat, toasts } = useStores();
  const router = useRouter();
  const opening = ref('');
  async function open(widget: QualifiedName): Promise<void> {
    opening.value = widget;
    try {
      await openChat({ chat, push: (to) => router.push(to) }, { title: fnLabel(widget), run: { fn: widget, args: {} } });
    } catch (error) {
      toasts.error("Couldn't open the widget", error instanceof Error ? error.message : String(error));
    } finally {
      opening.value = '';
    }
  }
  return { opening, open };
}
