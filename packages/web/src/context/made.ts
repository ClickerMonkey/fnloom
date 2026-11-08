/**
 * Telling the person context was made (from the resource browser, a resource's viewer, a chat's resource panel): how
 * many items were made or updated, with an Open button that goes to the first.
 */
import type { QualifiedName } from '@harness/core';
import type { Toasts } from '../state/toasts.ts';

/** Show that context was made; `open` goes to an item's page. */
export function toastContextMade(toasts: Pick<Toasts, 'push'>, made: readonly QualifiedName[], open: (name: QualifiedName) => void): void {
  const first = made[0];
  toasts.push({
    tone: 'ok', title: 'Context made', body: `${made.length} ${made.length === 1 ? 'item' : 'items'} made or updated.`,
    ...(first === undefined ? {} : { action: { label: 'Open', run: () => { open(first); } } }),
  });
}
