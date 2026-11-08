/** Numbers people read in the chat: money, durations, sizes and token counts. Pure, so they are tested alone. */

/** Dollars, exact below a cent: "$0", "$0.00042" (two significant digits), "$0.03", "$12.40", "$240". */
export function formatCost(usd: number): string {
  if (usd <= 0) { return '$0'; }
  if (usd < 0.01) {
    const decimals = 1 - Math.floor(Math.log10(usd));
    return `$${Number(usd.toPrecision(2)).toFixed(decimals).replace(/0+$/, '')}`;
  }
  return `$${usd < 100 ? usd.toFixed(2) : usd.toFixed(0)}`;
}

/** A duration in ms: "850ms", "4.2s", "1m 05s", "2h 03m". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe < 1_000) { return `${safe}ms`; }
  if (safe < 60_000) { return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}s`; }
  const minutes = Math.floor(safe / 60_000);
  if (minutes < 60) { return `${minutes}m ${String(Math.floor((safe % 60_000) / 1_000)).padStart(2, '0')}s`; }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** A size in bytes: "512 B", "4.2 KB", "12 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) { return `${bytes} B`; }
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) { value /= 1_024; unit++; }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit] ?? 'TB'}`;
}

/** A token count: "820", "12.4k", "1.2M". */
export function formatTokens(count: number): string {
  if (count < 1_000) { return String(count); }
  if (count < 1_000_000) { return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`; }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Shorten text to `max` characters on a word boundary (core's, shared with the hub). */
export { clamp } from '@harness/core';
