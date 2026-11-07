/** Small formatting rules the components share: counts, initials, relative times. Pure, so they are tested alone. */

/** The most a count badge shows before it says "99+". */
export const COUNT_CAP = 99;

/** A count for a badge: the number, or "99+" past the cap. */
export function countLabel(count: number): string {
  return count > COUNT_CAP ? `${COUNT_CAP}+` : String(count);
}

/** Up to two initials from a name or email: "Ada Lovelace" → "AL", "ada@example.com" → "A". */
export function initials(name: string): string {
  const base = name.includes('@') ? name.slice(0, name.indexOf('@')) : name;
  const words = base.trim().split(/[\s._-]+/).filter((word) => word !== '');
  const letters = words.length > 1 ? [words[0], words.at(-1)] : [words[0]];
  return letters.map((word) => word?.[0]?.toUpperCase() ?? '').join('') || '?';
}

/** A stable hue (0–359) for a name, so the same person always gets the same avatar colour. */
export function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) { hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0; }
  return hash % 360;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A short relative time: "just now", "5m", "3h", "yesterday", "4d", then a date ("12 Mar", or "12 Mar 2025" in
 * another year). `locale` is for the date, which follows the reader's language.
 */
export function relativeTime(at: number, now: number, locale?: string): string {
  const ago = now - at;
  if (ago < MINUTE) { return 'just now'; }
  if (ago < HOUR) { return `${Math.floor(ago / MINUTE)}m`; }
  if (ago < DAY) { return `${Math.floor(ago / HOUR)}h`; }
  if (ago < 2 * DAY) { return 'yesterday'; }
  if (ago < 7 * DAY) { return `${Math.floor(ago / DAY)}d`; }
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A full date and time for a tooltip or `datetime` attribute's label. */
export function fullTime(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
