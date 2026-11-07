/**
 * The composer of one session: the draft (text, mention chips, reply, reply-all), saved per session so it survives
 * switching chats and a reload; the picker the caret opens (`@` searches the session's mention providers, `/` its
 * commands, `!` the fns the person may run) with keyboard movement; the inline `!` form; staged files; and what a
 * send carries. A failed send puts the draft back exactly.
 */
import { MessageId, OutgoingPart, type ChatCapabilities, type MentionOption, type QualifiedName, type SessionId } from '@harness/core';
import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { z } from 'zod';
import { persisted, type KeyValueStore } from '../../state/persisted.ts';
import type { ChatApi } from '../api.ts';
import {
  commandHint, detectTrigger, draftParts, insertText, mentionToken, pruneMentions, type Command, type DraftMention, type Invocation, type Trigger,
} from '../logic/composer.ts';
import { fnLabel } from '../logic/labels.ts';
import type { Outgoing } from './thread.ts';
import type { UploadQueue } from './uploads.ts';

/** The key a session's draft is saved under. */
export const draftKey = (session: SessionId): string => `harness.draft.${session}`;

const SavedDraft = z.object({
  text: z.string(),
  mentions: z.array(OutgoingPart).transform((parts) => parts.filter((p): p is DraftMention => p.type === 'mention')),
  replyTo: MessageId.optional(),
  replyAll: z.boolean(),
});
type SavedDraft = z.infer<typeof SavedDraft>;

/** One entry of the picker. */
export type PickerItem =
  | { readonly kind: 'mention'; readonly key: string; readonly provider: QualifiedName; readonly group: string; readonly option: MentionOption }
  | { readonly kind: 'command'; readonly key: string; readonly command: Command }
  | { readonly kind: 'invoke'; readonly key: string; readonly invocation: Invocation };

/** How the picker searches: how long typing waits before `@` searches (ms), and results per provider. */
export interface PickerSettings {
  readonly delay: number;
  readonly perProvider: number;
  readonly max: number;
}

export const PICKER: PickerSettings = { delay: 120, perProvider: 6, max: 24 };

/** A draft as it was before a send, to put back if the send fails. */
export interface DraftSnapshot {
  readonly editing: MessageId | undefined;
  readonly text: string;
  readonly mentions: readonly DraftMention[];
  readonly replyTo: MessageId | undefined;
  readonly replyAll: boolean;
}

const sameTarget = (a: DraftMention, b: DraftMention): boolean => a.provider === b.provider && JSON.stringify(a.target) === JSON.stringify(b.target);

const matches = (query: string, ...texts: string[]): boolean => {
  const q = query.toLowerCase();
  return q === '' || texts.some((t) => t.toLowerCase().includes(q));
};

/** What the composer needs. */
export interface ComposerDeps {
  readonly session: SessionId;
  readonly store: KeyValueStore;
  readonly capabilities: () => ChatCapabilities | undefined;
  readonly api: Pick<ChatApi, 'mentions'>;
  readonly uploads: UploadQueue;
}

/** One session's composer. */
export class ComposerStore {
  readonly session: SessionId;
  readonly uploads: UploadQueue;
  readonly #deps: ComposerDeps;
  readonly #settings: PickerSettings;
  readonly #saved: Ref<SavedDraft | undefined>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  readonly text = ref('');
  readonly caret = ref(0);
  readonly mentions = shallowRef<readonly DraftMention[]>([]);
  readonly replyTo = ref<MessageId | undefined>(undefined);
  readonly replyAll = ref(false);
  /** The message being edited: sending undoes its turn and every later one, then sends the edit. */
  readonly editing = ref<MessageId | undefined>(undefined);
  /** The `!` fn whose form is open above the composer. */
  readonly invoking = shallowRef<Invocation | undefined>(undefined);
  /** Where the component should put the caret next (after a pick or an insert). */
  readonly caretRequest = ref<number | undefined>(undefined);

  readonly pickerItems = shallowRef<readonly PickerItem[]>([]);
  readonly pickerActive = ref(0);
  readonly pickerLoading = ref(false);
  readonly #dismissed = ref<string | undefined>(undefined);

  /** The trigger at the caret, if the hub offers that power. */
  readonly trigger = computed<Trigger | undefined>(() => {
    const trigger = detectTrigger(this.text.value, this.caret.value);
    const caps = this.#deps.capabilities();
    if (trigger === undefined || caps === undefined) { return undefined; }
    const offered = trigger.kind === 'mention' ? caps.mentions.length > 0 : trigger.kind === 'command' ? caps.commands.length > 0 : caps.invocations.length > 0;
    return offered ? trigger : undefined;
  });
  /** Whether the picker is open. */
  readonly pickerOpen = computed(() => {
    const trigger = this.trigger.value;
    return trigger !== undefined && this.#dismissed.value !== `${trigger.kind}:${trigger.start}`;
  });
  /** The command argument hint, while typing a command's arguments. */
  readonly hint = computed(() => commandHint(this.text.value, this.#deps.capabilities()?.commands ?? []));
  /** Whether there is anything to send, and nothing still uploading. */
  readonly canSend = computed(() => !this.uploads.busy.value && (this.text.value.trim() !== '' || this.uploads.parts.value.length > 0));

  constructor(deps: ComposerDeps, settings: PickerSettings = PICKER) {
    this.session = deps.session;
    this.uploads = deps.uploads;
    this.#deps = deps;
    this.#settings = settings;
    this.#saved = persisted(deps.store, draftKey(deps.session), SavedDraft.optional(), undefined);
    const saved = this.#saved.value;
    if (saved !== undefined) {
      this.text.value = saved.text;
      this.caret.value = saved.text.length;
      this.mentions.value = saved.mentions;
      this.replyTo.value = saved.replyTo;
      this.replyAll.value = saved.replyAll;
    }
    watch([this.text, this.mentions, this.replyTo, this.replyAll], () => { this.#save(); });
    watch(() => [this.trigger.value?.kind, this.trigger.value?.query, this.trigger.value?.start], () => { this.#search(); });
  }

  /** The person typed: the text and where the caret is. */
  input(text: string, caret: number): void {
    this.text.value = text;
    this.caret.value = caret;
    this.mentions.value = pruneMentions(text, this.mentions.value);
  }

  /** The caret moved without the text changing. */
  moveCaret(caret: number): void {
    this.caret.value = caret;
  }

  /** Move the picker's highlight by `delta`, wrapping. */
  movePicker(delta: number): void {
    const count = this.pickerItems.value.length;
    if (count === 0) { return; }
    this.pickerActive.value = (this.pickerActive.value + delta + count) % count;
  }

  /** Close the picker until the caret leaves this trigger. */
  dismissPicker(): void {
    const trigger = this.trigger.value;
    if (trigger !== undefined) { this.#dismissed.value = `${trigger.kind}:${trigger.start}`; }
  }

  /** Pick an item (the highlighted one by default). */
  pick(item: PickerItem | undefined = this.pickerItems.value[this.pickerActive.value]): void {
    const trigger = this.trigger.value;
    if (item === undefined || trigger === undefined) { return; }
    if (item.kind === 'mention') {
      const mention: DraftMention = { type: 'mention', provider: item.provider, label: item.option.label, target: item.option.target };
      const known = this.mentions.value.find((m) => sameTarget(m, mention));
      const chip = known ?? mention;
      this.#replace(trigger, `${mentionToken(chip)} `);
      if (known === undefined) { this.mentions.value = [...this.mentions.value, chip]; }
    } else if (item.kind === 'command') {
      this.#replace(trigger, `/${item.command.name} `);
    } else {
      this.#replace(trigger, '');
      this.invoking.value = item.invocation;
    }
  }

  /** Open a fn's `!` form directly (a suggested fn, a type method). */
  openInvocation(invocation: Invocation): void {
    this.invoking.value = invocation;
  }

  closeInvocation(): void {
    this.invoking.value = undefined;
  }

  /** Put text at the caret (dictation, a starter, a suggested command). */
  insert(text: string): void {
    const at = this.caret.value;
    const before = this.text.value.slice(0, at);
    const spaced = before === '' || /\s$/.test(before) ? text : ` ${text}`;
    const next = insertText(this.text.value, at, at, spaced);
    this.text.value = next.text;
    this.caret.value = next.caret;
    this.caretRequest.value = next.caret;
  }

  /** Replace the whole draft (Up to recall the last message, Edit). */
  replace(text: string): void {
    this.text.value = text;
    this.caret.value = text.length;
    this.caretRequest.value = text.length;
    this.mentions.value = pruneMentions(text, this.mentions.value);
  }

  setReply(message: MessageId | undefined): void {
    this.replyTo.value = message;
  }

  /** What a send carries now. Undefined when there is nothing to send. */
  outgoing(): Outgoing | undefined {
    if (!this.canSend.value) { return undefined; }
    const parts = [...draftParts(this.text.value, this.mentions.value, this.#deps.capabilities()?.commands ?? []), ...this.uploads.parts.value];
    if (parts.length === 0) { return undefined; }
    return { parts, replyTo: this.replyTo.value, replyAll: this.replyAll.value };
  }

  /** Edit an earlier message in the composer: its text and chips come back, and sending replaces it. */
  startEdit(message: MessageId, text: string, mentions: readonly DraftMention[]): void {
    this.editing.value = message;
    this.replyTo.value = undefined;
    this.mentions.value = mentions;
    this.replace(text);
  }

  /** Stop editing; the draft empties. */
  cancelEdit(): void {
    this.editing.value = undefined;
    this.clear();
  }

  snapshot(): DraftSnapshot {
    return { editing: this.editing.value, text: this.text.value, mentions: this.mentions.value, replyTo: this.replyTo.value, replyAll: this.replyAll.value };
  }

  restore(snapshot: DraftSnapshot): void {
    this.editing.value = snapshot.editing;
    this.text.value = snapshot.text;
    this.caret.value = snapshot.text.length;
    this.mentions.value = snapshot.mentions;
    this.replyTo.value = snapshot.replyTo;
    this.replyAll.value = snapshot.replyAll;
  }

  /** Empty the draft (and, unless kept for a send that may still fail, the staged files). Reply-all stays as set. */
  clear(files: 'clear' | 'keep' = 'clear'): void {
    this.text.value = '';
    this.caret.value = 0;
    this.caretRequest.value = 0;
    this.mentions.value = [];
    this.replyTo.value = undefined;
    this.editing.value = undefined;
    if (files === 'clear') { this.uploads.clear(); }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.uploads.clear();
  }

  #replace(trigger: Trigger, insert: string): void {
    const next = insertText(this.text.value, trigger.start, trigger.end, insert);
    this.text.value = next.text;
    this.caret.value = next.caret;
    this.caretRequest.value = next.caret;
  }

  #save(): void {
    const empty = this.text.value === '' && this.replyTo.value === undefined && !this.replyAll.value;
    this.#saved.value = empty ? undefined : { text: this.text.value, mentions: [...this.mentions.value], replyAll: this.replyAll.value, ...(this.replyTo.value === undefined ? {} : { replyTo: this.replyTo.value }) };
  }

  #search(): void {
    clearTimeout(this.#timer);
    const generation = ++this.#generation;
    this.pickerActive.value = 0;
    const trigger = this.trigger.value;
    const caps = this.#deps.capabilities();
    if (trigger === undefined || caps === undefined) {
      this.pickerItems.value = [];
      this.pickerLoading.value = false;
      return;
    }
    if (trigger.kind === 'command') {
      this.pickerItems.value = caps.commands.filter((c) => matches(trigger.query, c.name, c.description))
        .slice(0, this.#settings.max).map((command) => ({ kind: 'command', key: `c:${command.context}:${command.name}`, command }));
      return;
    }
    if (trigger.kind === 'invoke') {
      this.pickerItems.value = caps.invocations.filter((i) => matches(trigger.query, i.fn, fnLabel(i.fn), i.description))
        .slice(0, this.#settings.max).map((invocation) => ({ kind: 'invoke', key: `i:${invocation.fn}`, invocation }));
      return;
    }
    this.pickerLoading.value = true;
    this.#timer = setTimeout(() => { void this.#searchMentions(trigger.query, caps.mentions, generation); }, this.#settings.delay);
  }

  async #searchMentions(query: string, providers: ChatCapabilities['mentions'], generation: number): Promise<void> {
    const groups = await Promise.all(providers.map(async (provider) => {
      try {
        const options = await this.#deps.api.mentions.call({ session: this.session, provider: provider.provider, query });
        return options.slice(0, this.#settings.perProvider).map((option, i): PickerItem => ({
          kind: 'mention', key: `m:${provider.provider}:${i}:${option.label}`, provider: provider.provider, group: provider.title, option,
        }));
      } catch {
        return [];
      }
    }));
    if (generation !== this.#generation) { return; }
    this.pickerItems.value = groups.flat().slice(0, this.#settings.max);
    this.pickerLoading.value = false;
  }
}
