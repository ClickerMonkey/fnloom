/**
 * The chat's keyboard shortcuts, defined once: what each does, the keys shown for it, and the test that matches a key
 * press. Shortcuts that are plain characters never fire while typing in a field. Pure, so it is tested alone.
 */

/** What a shortcut does. */
export type ShortcutAction = 'focus-composer' | 'search' | 'new-chat' | 'previous-chat' | 'next-chat' | 'help';

/** The part of a key press a shortcut reads. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

interface Shortcut {
  readonly action: ShortcutAction;
  readonly label: string;
  readonly keys: readonly string[];
  /** Whether it still fires while typing in a field. */
  readonly inFields: boolean;
  readonly matches: (event: KeyPress) => boolean;
}

const mod = (event: KeyPress): boolean => event.ctrlKey || event.metaKey;

/** Every shortcut, in the order the list shows them. */
export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'search', label: 'Search chats', keys: ['Ctrl', 'K'], inFields: true, matches: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === 'k' },
  { action: 'new-chat', label: 'New chat', keys: ['Ctrl', 'Shift', 'O'], inFields: true, matches: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === 'o' },
  { action: 'previous-chat', label: 'Previous chat', keys: ['Alt', '↑'], inFields: true, matches: (e) => e.altKey && e.key === 'ArrowUp' },
  { action: 'next-chat', label: 'Next chat', keys: ['Alt', '↓'], inFields: true, matches: (e) => e.altKey && e.key === 'ArrowDown' },
  { action: 'focus-composer', label: 'Write a message', keys: ['/'], inFields: false, matches: (e) => e.key === '/' && !mod(e) && !e.altKey },
  { action: 'help', label: 'Keyboard shortcuts', keys: ['?'], inFields: false, matches: (e) => e.key === '?' && !mod(e) && !e.altKey },
];

/** Extra keys the list shows that the composer handles itself. */
export const COMPOSER_KEYS: readonly { readonly label: string; readonly keys: readonly string[] }[] = [
  { label: 'Send', keys: ['Enter'] },
  { label: 'New line', keys: ['Shift', 'Enter'] },
  { label: 'Send from anywhere in the box', keys: ['Ctrl', 'Enter'] },
  { label: 'Edit your last message', keys: ['↑'] },
  { label: 'Close the top panel', keys: ['Esc'] },
];

/** The shortcut a key press means, if any. `inField`: focus is in a text field. */
export function shortcutFor(event: KeyPress, inField: boolean): ShortcutAction | undefined {
  return SHORTCUTS.find((s) => (s.inFields || !inField) && s.matches(event))?.action;
}

/** Whether an element takes typing (so plain-key shortcuts stay quiet). */
export function isTyping(element: Element | null): boolean {
  if (element === null) { return false; }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) { return true; }
  if (element instanceof HTMLInputElement) { return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(element.type); }
  return element instanceof HTMLElement && element.isContentEditable;
}
