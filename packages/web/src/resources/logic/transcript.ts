/**
 * Transcripts beside audio and video: a transcript's text read into lines, each with the time it starts at when it
 * has one (`[01:02] words`, `1:02:03 words`, or the cues of SRT and WebVTT), so a click on a line seeks the player
 * there; and the line playing at a time. Pure, so it is tested alone.
 */

/** One line of a transcript, with the second it starts at when it says. */
export interface TranscriptLine {
  readonly at: number | undefined;
  readonly text: string;
}

const STAMP = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*(?:-->\s*\S+\s*)?(.*)$/;

/** A clock time (`1:02:03.5`, `02:03`) in seconds. */
export function secondsOf(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + (Number.isFinite(part) ? part : 0), 0);
}

/** Seconds as a clock time: `1:02` or `1:02:03`. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A transcript's lines: SRT and WebVTT cues become one line each, other text one line per line. */
export function transcriptLines(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let pending: number | undefined;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line === 'WEBVTT' || /^\d+$/.test(line)) { continue; }
    const stamp = STAMP.exec(line);
    if (stamp !== null && stamp[1] !== undefined) {
      const rest = (stamp[2] ?? '').trim();
      if (rest === '') { pending = secondsOf(stamp[1]); continue; }
      out.push({ at: secondsOf(stamp[1]), text: rest });
      continue;
    }
    out.push({ at: pending, text: line });
    pending = undefined;
  }
  return out;
}

/** The index of the line playing at `time` (the last one starting at or before it), or -1. */
export function lineAt(lines: readonly TranscriptLine[], time: number): number {
  let found = -1;
  lines.forEach((line, i) => { if (line.at !== undefined && line.at <= time) { found = i; } });
  return found;
}
