/**
 * Prop and event shapes the chat's components share, and the handles their owners hold (what each exposes). They
 * live here, not in the components, so plain TypeScript (and lint) sees them.
 */
import type { ApprovalId, Json, QualifiedName } from '@harness/core';
import type { Component } from 'vue';
import type { IconName } from '../../ui/index.ts';

/** A system's renderer and the props to mount it with. */
export interface RenderView {
  readonly component: Component;
  readonly props: Readonly<Record<string, unknown>>;
}

/** What a message's action bar can offer. */
export type MessageAction = 'copy' | 'reply' | 'edit' | 'retry' | 'undo' | 'details' | 'tree' | 'link';

/** What the chat header's tools and overflow menu offer. */
export type HeaderAction = 'rename' | 'tree' | 'undo' | 'settings' | 'people' | 'archive' | 'shortcuts';

/** One approval as the tray shows it. */
export interface ApprovalView {
  readonly id: ApprovalId;
  readonly fn: QualifiedName;
  readonly description: string;
  readonly args: Json | undefined;
}

/** A starter on an empty chat: what it says, and what tapping it sends. */
export interface Starter {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly icon: IconName;
}

/** The thread's scroller. */
export interface ScrollerHandle {
  /** Go to the bottom and follow new content again. */
  toBottom(smooth?: boolean): void;
  /** Bring an element of the thread into view by id; whether it was found. */
  reveal(id: string): boolean;
}

/** The composer. */
export interface ComposerHandle {
  focus(): void;
}

/** The session list. */
export interface SessionListHandle {
  focusSearch(): void;
}

/** An editable title. */
export interface TitleHandle {
  start(): Promise<void>;
}
