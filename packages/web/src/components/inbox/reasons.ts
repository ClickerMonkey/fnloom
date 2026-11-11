/**
 * How each notification reason looks: its icon, tone and a short label. Keyed by the hub's `NotificationReason`, so
 * a new reason fails to compile here until it has a look.
 */
import type { NotificationReason } from '@harness/core';
import type { IconName, Tone } from '../../ui/index.ts';

export interface ReasonLook {
  readonly icon: IconName;
  readonly tone: Tone;
  readonly label: string;
}

export const REASONS = {
  'approval-needed': { icon: 'shield', tone: 'warn', label: 'Approval needed' },
  'input-needed': { icon: 'edit', tone: 'warn', label: 'Input needed' },
  'config-needed': { icon: 'settings', tone: 'warn', label: 'Setup needed' },
  message: { icon: 'chat', tone: 'accent', label: 'Message' },
  replied: { icon: 'chat', tone: 'accent', label: 'Reply' },
  'turn-finished': { icon: 'success', tone: 'ok', label: 'Finished' },
  'turn-failed': { icon: 'error', tone: 'danger', label: 'Failed' },
  'pairing-requested': { icon: 'key', tone: 'accent', label: 'Pairing' },
  'system-disconnected': { icon: 'offline', tone: 'danger', label: 'Disconnected' },
  'spend-limit': { icon: 'warning', tone: 'danger', label: 'Spend limit' },
  'system-paused': { icon: 'pause', tone: 'danger', label: 'System paused' },
} as const satisfies Record<NotificationReason, ReasonLook>;

/** How a notification looks: its reason's look, quietened once what it asked for has happened (`resolved`). */
export function lookOf(notification: { readonly reason: NotificationReason; readonly resolved?: string | undefined }): ReasonLook {
  const look = REASONS[notification.reason];
  return notification.resolved === undefined ? look : { icon: 'check', tone: 'neutral', label: `${look.label} · ${notification.resolved}` };
}
