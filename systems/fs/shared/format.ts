/** Small display helpers the server (hover cards, tree) and the renderers share. Browser-safe. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const STEP = 1024;

/** A byte count for people: `0 B`, `812 B`, `28 KB`, `4.2 MB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${UNITS[unit] ?? 'B'}`;
}

/** The last segment of a `/`-separated path. */
export function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/** The number of lines in a text, not counting an empty last line after a final newline. */
export function lineCount(text: string): number {
  if (text === '') { return 0; }
  const parts = text.split('\n').length;
  return text.endsWith('\n') ? parts - 1 : parts;
}
