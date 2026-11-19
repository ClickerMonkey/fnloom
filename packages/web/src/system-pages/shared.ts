/**
 * The app's components a system page reuses (`PageHost.components`, the SDK's `SharedComponents`): the page frame, the
 * text input, the markdown view, icons, the empty and load states, the chat's reasoning block and typing dots, the resource viewer and
 * the gin value editor; the app's controls (button, select, text area, dialog, banner, badge, skeleton) and fn pills; and
 * the chat's own parts for an approval, a conversation and the composer (item 8). A system draws with these, so its page
 * looks and behaves like the app's own.
 */
import type { PageFormat, SharedComponents } from '@harness/sdk';
import { markRaw } from 'vue';
import LoadState from '../admin/components/LoadState.vue';
import AppPage from '../app/AppPage.vue';
import ReasoningBlock from '../chat/components/ReasoningBlock.vue';
import { formatCost } from '../chat/logic/format.ts';
import TypingDots from '../chat/components/TypingDots.vue';
import FnPill from '../fns/components/FnPill.vue';
import GinValueView from '../gin/GinValueView.vue';
import ResourceViewer from '../resources/ResourceViewer.vue';
import { fullTime, relativeTime, UiBadge, UiBanner, UiButton, UiDialog, UiEmpty, UiIcon, UiInput, UiMarkdown, UiSelect, UiSkeleton, UiTextarea } from '../ui/index.ts';
import PageApproval from './PageApproval.vue';
import PageComposer from './PageComposer.vue';
import PageConversation from './PageConversation.vue';

/** Each shared component under its SDK name, never wrapped in a reactive proxy. Its props are checked against the SDK's. */
export const SHARED_COMPONENTS: SharedComponents = Object.freeze({
  Frame: markRaw(AppPage),
  Input: markRaw(UiInput),
  Markdown: markRaw(UiMarkdown),
  Icon: markRaw(UiIcon),
  Empty: markRaw(UiEmpty),
  LoadState: markRaw(LoadState),
  Reasoning: markRaw(ReasoningBlock),
  Typing: markRaw(TypingDots),
  ResourceViewer: markRaw(ResourceViewer),
  ValueEditor: markRaw(GinValueView),
  Button: markRaw(UiButton),
  Select: markRaw(UiSelect),
  Textarea: markRaw(UiTextarea),
  Dialog: markRaw(UiDialog),
  Banner: markRaw(UiBanner),
  Badge: markRaw(UiBadge),
  Skeleton: markRaw(UiSkeleton),
  FnPill: markRaw(FnPill),
  Approval: markRaw(PageApproval),
  Conversation: markRaw(PageConversation),
  Composer: markRaw(PageComposer),
});

/** Money and times as the app writes them (`PageHost.format`): the chat's cost, and the app's relative and full times. */
export const PAGE_FORMAT: PageFormat = Object.freeze({
  cost: formatCost,
  relativeTime: (at: number, now: number) => relativeTime(at, now),
  fullTime: (at: number) => fullTime(at),
});
