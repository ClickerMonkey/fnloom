/**
 * What a system page reaches through its host besides the hub client (item 8/9): runs it starts as the person's own
 * runs in a harness chat (`host.runs`), the approvals waiting outside a chat (`host.inbox`), short notes to the person
 * (`host.notify`), and the props of the app's controls and chat parts it draws with (`host.components`). The app
 * implements them with its own stores and components, so a page never draws a copy of the chat.
 */
import type { Approval, InstanceName, Json, QualifiedName, Remember, RunId, SessionId } from '@harness/core';
import type { RunOutcome } from './client.ts';

/** What a page's runs are called in: the chat made for them is named by `title` (read when it is made). */
export interface PageRunsOptions {
  readonly title: () => string;
}

/**
 * Runs a page starts (`host.runs({ title })`): each is the person's own run in a harness chat, so the hub's approval
 * rules see it and the chat records it. The chat is made the first time something runs, unless `attach` names one (an
 * item's own chat). A run that stops for approval waits in `approvals`, answered on the page (`components.Approval`
 * with `inChat`) or in the chat. Its fields are reactive.
 */
export interface PageRuns {
  /** The approvals waiting in the chat, oldest first. */
  readonly approvals: readonly Approval[];
  /** What the chat's last call or answer couldn't do, in words; '' when nothing failed. */
  readonly problem: string;
  /** A run's args in the chat, once known (to tell which approvals are about what the page shows). */
  argsOf(run: RunId): Json | undefined;
  /** Run in this chat instead of making one; nothing changes once a chat is open. */
  attach(session: SessionId): void;
  /**
   * Run a fn, resolving when it settles with its output or why not (never early: a run the hub says is done ends with
   * its outcome). `on` names the instance it runs on; `waiting` is called once if it stops for approval.
   */
  run(fn: QualifiedName, args: Json, options?: { readonly on?: InstanceName; readonly waiting?: () => void }): Promise<RunOutcome>;
  /** Answer one of `approvals`; false (with `problem` set) when the hub refused. */
  approve(approval: Approval, approve: boolean, remember: Remember, reason: string, answer: Json | undefined): Promise<boolean>;
  /** Read the runs the approvals wait on again (one may have been answered elsewhere). */
  refresh(): void;
  /** Stop listening to the chat (the page left). */
  close(): void;
}

/** The approvals outside any chat (the inbox's), for runs a page knows wait on the person. Its fields are reactive. */
export interface PageInbox {
  /** The approval a run waits on, once `load` read it. */
  byRun(run: RunId): Approval | undefined;
  load(runs: readonly RunId[]): Promise<void>;
  /** Answer one; false (with `problem` set) when the hub refused. */
  decide(approval: Approval, approve: boolean, reason: string, answer: Json | undefined): Promise<boolean>;
  readonly problem: string;
}

/** Short notes to the person, as the app's toasts. */
export interface PageNotify {
  ok(title: string, detail?: string): void;
  error(title: string, detail?: string): void;
}

/** Money and times as the rest of the app writes them. */
export interface PageFormat {
  /** Dollars, as the chat writes a run's cost ("$0.03", "$0.00042"). */
  cost(usd: number): string;
  /** How long ago, short ("5m ago"); `now` is the time to count from (ms). */
  relativeTime(at: number, now: number): string;
  /** The full date and time, for a tooltip. */
  fullTime(at: number): string;
}

// ─── the props of the shared controls ─────────────────────────────────────────

/** A colour of a status. */
export type PartTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

/** Props of the app's button (`@click`); `primary` is the one main action on a surface. */
export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit' | 'reset';
  icon?: string | undefined;
  iconRight?: string | undefined;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
}

/** One choice of a select. */
export interface SelectChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** Props of the app's select (`v-model` is the chosen value). */
// a type, not an interface: the app's select is generic, and Vue checks a generic component's props as a plain record
export type SelectProps = { modelValue: string; options: readonly SelectChoice[]; label?: string; hint?: string; error?: string; required?: boolean; disabled?: boolean; hideLabel?: boolean; size?: 'sm' | 'md' };
/** Props of the app's growing text area (`v-model` is the text). */
export interface TextareaProps { modelValue: string; label?: string; hint?: string; error?: string; placeholder?: string; rows?: number; maxRows?: number; required?: boolean; disabled?: boolean; hideLabel?: boolean }
/** Props of the app's dialog (`v-model:open`); slots: the body, and `footer` for its buttons. */
export interface DialogProps { open: boolean; title: string; description?: string; width?: string }
/** Props of the app's banner; slots: the text, and `actions`. */
export interface BannerProps { tone?: PartTone; icon?: string | undefined }
/** Props of the app's badge (a status word with its dot, which pulses while `live`). */
export interface BadgeProps { tone?: PartTone; dot?: boolean; live?: boolean }
/** Props of the app's loading skeleton. */
export interface SkeletonProps { shape?: 'lines' | 'circle' | 'block'; lines?: number; size?: number }
/** Props of a fn as a pill (its friendly label tinted by its system; a click opens the app's fn modal). */
export interface FnPillProps { name: string; label?: string | undefined; off?: boolean }

/**
 * Props of an approval card (`@decide(approve, remember, reason, answer)`): what the run will do, then Approve or Deny
 * (a form to fill first when it asks for one). `inChat` says it is answered in a chat (`PageRuns.approve`), where the
 * answer may be remembered; otherwise (`PageInbox.decide`) every answer is for this run only.
 */
export interface ApprovalProps { approval: Approval; inChat?: boolean; description?: string }

// ─── a conversation drawn with the chat's own parts ──────────────────────────

/** A call the agent made (a tool use): drawn as the chat's run card, its output in brief once it settled. */
export interface ConversationCall {
  readonly key: string;
  /** The tool's name, shown as its label. */
  readonly name: string;
  readonly args: Json;
  readonly status: 'running' | 'done' | 'failed';
  /** What it gave back (or why it failed), as text. */
  readonly output?: string | undefined;
}

/** One piece of an answer, in the order the agent made them. */
export type ConversationPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'call'; readonly call: ConversationCall };

/** One entry of a conversation: the person's message, an answer (its pieces), or a quiet note. `at` is when (ms). */
export type ConversationEntry =
  | { readonly kind: 'user'; readonly key: string; readonly text: string; readonly at?: number | undefined }
  | { readonly kind: 'answer'; readonly key: string; readonly pieces: readonly ConversationPiece[]; readonly at?: number | undefined }
  | { readonly kind: 'note'; readonly key: string; readonly text: string };

/**
 * Props of a conversation drawn with the chat's own parts: the person's messages as the chat's bubbles, each answer
 * as the chat's answer (markdown words, reasoning folded where it happened, calls as run cards, a stretch of calls
 * folded into one section). `system` names whose calls they are; `streaming` says the last answer is still arriving.
 */
export interface ConversationProps { entries: readonly ConversationEntry[]; agent: string; system: string; streaming?: boolean }

/**
 * Props of the chat's composer (`v-model` is the text; `@send`, and `@stop` while `running`): Enter sends on a
 * keyboard, the box grows with its text, and Stop sits beside Send while work runs. `note` is a short line under it.
 */
export interface ComposerProps { modelValue: string; placeholder?: string; sending?: boolean; running?: boolean; stopping?: boolean; disabled?: boolean; note?: string }
