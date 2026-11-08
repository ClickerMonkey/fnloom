/**
 * The template system's client renderers: Vue components for what its contract declares, each typed by it. The chat
 * loads the built module from the hub. Without renderers the chat draws everything itself, so this can stay empty.
 */
import { client } from '@harness/sdk';
import { template } from '../shared/index.ts';

export default client(template, {
  // fns: how runs of a fn are drawn: `{ <fn>: Component }`, props `FnViewOf<typeof template, '<fn>'>`.
  // kinds: how fns of a kind are drawn when the fn has no renderer of its own: `{ <kind>: Component }`.
  // attachments: `{ <attachment>: Component }`, props `AttachmentViewOf<typeof template, '<attachment>'>`.
  // inputs: editors (and, read-only, viewers) of named types: `{ <Type>: Component }`, props `InputViewOf<typeof template, '<Type>'>`.
  // mentions: hover cards of mention providers: `{ <mention>: Component }`, props `MentionView<Target> & WithSystem<...>`.
  // resources: viewers of resource formats: `{ <format>: Component }`, props `ResourceView & WithSystem<...>`.
  // TODO: add renderers in .vue files beside this one and list them here, or delete these comments.
});
