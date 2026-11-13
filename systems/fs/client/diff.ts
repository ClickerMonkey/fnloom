/**
 * Line diffs for the diff attachment and a command's changes: Myers' algorithm over lines, then hunks with a few lines
 * of context and the unchanged runs between them folded; or the hunks of a unified diff (git's), with the lines it
 * leaves out between them as gaps. Pure, so the components only draw.
 */

/** One line of a diff. Line numbers are 1-based; a removed line has no new number, an added line no old one. */
export type DiffLine =
  | { readonly kind: 'same'; readonly text: string; readonly old: number; readonly new: number }
  | { readonly kind: 'removed'; readonly text: string; readonly old: number }
  | { readonly kind: 'added'; readonly text: string; readonly new: number };

/**
 * A run of lines to show, a fold of unchanged lines between them (which can be opened), or a gap of unchanged lines a
 * unified diff leaves out (which can't: only their count is known).
 */
export type DiffBlock =
  | { readonly kind: 'lines'; readonly lines: readonly DiffLine[] }
  | { readonly kind: 'fold'; readonly lines: readonly DiffLine[] }
  | { readonly kind: 'gap'; readonly count: number };

/** A block that holds its lines (a run or a fold), as a before/after diff makes them. */
export type LineBlock = Exclude<DiffBlock, { readonly kind: 'gap' }>;

/** Split text into lines, without an empty last line after a final newline. */
export function splitLines(text: string): string[] {
  if (text === '') { return []; }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') { lines.pop(); }
  return lines;
}

/** The shortest edit script from `a` to `b` (Myers, O((n + m) d)). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const max = a.length + b.length;
  const offset = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  const trace: number[][] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) { found = true; break; }
    }
  }
  // walk back through the trace to recover the path
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d] ?? [];
    const k = x - y;
    const down = k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1; y -= 1;
      out.push({ kind: 'same', text: a[x] ?? '', old: x + 1, new: y + 1 });
    }
    if (d === 0) { break; }
    if (down) {
      y -= 1;
      out.push({ kind: 'added', text: b[y] ?? '', new: y + 1 });
    } else {
      x -= 1;
      out.push({ kind: 'removed', text: a[x] ?? '', old: x + 1 });
    }
  }
  return out.reverse();
}

/** How many lines were added and removed. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
  };
}

/** Changed lines with `context` unchanged lines around them; longer unchanged runs are folded. */
export function diffBlocks(lines: readonly DiffLine[], context: number): LineBlock[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind === 'same') { return; }
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) { keep[j] = true; }
  });
  const blocks: LineBlock[] = [];
  let run: DiffLine[] = [];
  let shown = true;
  for (const [i, line] of lines.entries()) {
    const show = keep[i] === true;
    if (show !== shown && run.length > 0) {
      blocks.push({ kind: shown ? 'lines' : 'fold', lines: run });
      run = [];
    }
    shown = show;
    run.push(line);
  }
  if (run.length > 0) { blocks.push({ kind: shown ? 'lines' : 'fold', lines: run }); }
  return blocks;
}

/** A hunk header: `@@ -12,5 +12,6 @@`. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The blocks of a unified diff: each hunk's lines, numbered from its header, with a gap for the unchanged lines before,
 * between and (when the old side's length is unknown) not after the hunks. The header lines before the first hunk and
 * "No newline at end of file" notes are left out.
 */
export function patchBlocks(patch: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let lines: DiffLine[] = [];
  let old = 0;
  let now = 0;
  /** The next old line after the last hunk, so a gap before the next one can be counted. */
  let next = 1;
  let started = false;
  const close = () => { if (lines.length > 0) { blocks.push({ kind: 'lines', lines }); lines = []; } };
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk !== null) {
      close();
      started = true;
      old = Number(hunk[1]);
      now = Number(hunk[3]);
      // a hunk of an empty side starts at 0
      const from = Math.max(old, 1);
      if (from > next) { blocks.push({ kind: 'gap', count: from - next }); }
      next = from + Number(hunk[2] ?? '1');
      continue;
    }
    if (!started) { continue; }
    if (raw.startsWith('+')) { lines.push({ kind: 'added', text: raw.slice(1), new: now }); now += 1; } else if (raw.startsWith('-')) { lines.push({ kind: 'removed', text: raw.slice(1), old }); old += 1; } else if (raw.startsWith(' ')) { lines.push({ kind: 'same', text: raw.slice(1), old, new: now }); old += 1; now += 1; }
  }
  close();
  return blocks;
}

/** How many lines a set of blocks adds and removes. */
export function blockStats(blocks: readonly DiffBlock[]): { added: number; removed: number } {
  return diffStats(blocks.flatMap((block) => (block.kind === 'gap' ? [] : block.lines)));
}
