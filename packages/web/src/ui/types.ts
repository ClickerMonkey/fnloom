/** The prop shapes the design system's components share, so callers and components name them the same way. */
import type { IconName } from './icons.ts';

/** A button's look. `primary` is the one main action on a surface. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** A control's size. */
export type ControlSize = 'sm' | 'md' | 'lg';

/** The colour of a status: neutral, the accent, or ok, warn and danger. */
export const TONES = ['neutral', 'accent', 'ok', 'warn', 'danger'] as const;
export type Tone = (typeof TONES)[number];

/** One option of a segmented control. */
export interface SegmentOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly icon?: IconName;
}

/** One choice of a select. */
export interface SelectOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The options of a label record, in the record's order. Writing the choices as `{ value: label }` with
 * `satisfies Record<V, string>` makes a new value break the record until it is named, so no choice is forgotten.
 */
export function optionsOf<V extends string>(labels: Readonly<Record<V, string>>): { readonly value: V; readonly label: string }[] {
  return Object.keys(labels).filter((key): key is V => Object.hasOwn(labels, key)).map((value) => ({ value, label: labels[value] }));
}

/** One tab. */
export interface TabItem<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly icon?: IconName;
  /** A count shown after the label; hidden when 0. */
  readonly count?: number;
}

/** An action in a menu. */
export interface MenuAction<V extends string> {
  readonly kind?: 'action';
  readonly value: V;
  readonly label: string;
  readonly icon?: IconName;
  /** A short hint at the end, such as a key. */
  readonly hint?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

/** A line between groups of menu actions. */
export interface MenuSeparator {
  readonly kind: 'separator';
}

/** An item in a menu. */
export type MenuItem<V extends string> = MenuAction<V> | MenuSeparator;

/** A toast as the toaster shows it. */
export interface ToastView {
  readonly id: number;
  readonly tone: Tone;
  readonly title: string;
  readonly body?: string;
  /** A button on the toast; choosing it emits `action` with the toast's id. */
  readonly action?: string;
}

/** A person or agent's presence dot on an avatar. */
export type Presence = 'online' | 'busy' | 'away' | 'offline';

/** Where a modal's panel sits: the centre (dialogs) or an edge (drawers and sheets). */
export type ModalPlacement = 'center' | 'left' | 'right' | 'bottom';
