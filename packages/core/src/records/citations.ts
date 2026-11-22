/**
 * Citations (iteration 2, Phil's "Use citations"): with a chat's `citations` setting on, the model cites the tool
 * results its claims come from as `<cite tool="run_…" path="results.0.title">why this is evidence</cite>`. The hub
 * parses each answer's cites once, when it settles, resolves each to its run and the value at its path, numbers them
 * in chat order and keeps them on the message (`ChatMessage.citations`). The stored text keeps a marker in each cite's
 * place (`citeMarker`), which the chat draws as a `[n]` chip.
 */
import { z } from 'zod';
import { Json, QualifiedName, RunId } from '../primitives.ts';

/** The tag the model writes a cite in. */
export const CITE_TAG = 'cite';

/** What opens and closes a cite's marker in stored text: two private-use characters (U+E000, U+E001) no one types. */
export const CITE_MARKER_OPEN = String.fromCharCode(0xe000);
export const CITE_MARKER_CLOSE = String.fromCharCode(0xe001);

/** Every cite marker in a text; group 1 is its index among the message's cites. */
export const CITE_MARKER = new RegExp(`${CITE_MARKER_OPEN}(\\d+)${CITE_MARKER_CLOSE}`, 'g');

/** The marker that stands in a message's text for its cite at `index` (from 1). */
export function citeMarker(index: number): string {
  return `${CITE_MARKER_OPEN}${index}${CITE_MARKER_CLOSE}`;
}

/** A text with its cite markers as `[n]`, by the message's citations (a marker with no citation is left out). */
export function citeMarkersAsText(text: string, citations: readonly Pick<Citation, 'index' | 'number'>[] = []): string {
  const numbers = new Map(citations.map((c) => [c.index, c.number]));
  return text.replace(CITE_MARKER, (_, index: string) => {
    const n = numbers.get(Number(index));
    return n === undefined ? '' : `[${n}]`;
  });
}

/** A JSON path's steps: `results.0.title`, `$.rows[3]`, `items["a b"]`; '' (or a bare `$`) is the whole value. */
export function pathSteps(path: string): string[] | undefined {
  const trimmed = path.trim().replace(/^\$\.?/, '');
  if (trimmed === '') return [];
  const steps: string[] = [];
  const step = /\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]|([^.[\]]+)/y;
  let at = 0;
  while (at < trimmed.length) {
    if (trimmed[at] === '.') { at += 1; continue; }
    step.lastIndex = at;
    const match = step.exec(trimmed);
    if (match === null) return undefined;
    steps.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
    at = step.lastIndex;
  }
  return steps;
}

/** A text's JSON, when it is JSON. */
function parsedJson(text: string): Json | undefined {
  try {
    return Json.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The value at a path in a value, if it has one. A step into a JSON text reads the JSON. */
export function valueAt(value: Json, path: string): { value: Json } | undefined {
  const steps = pathSteps(path);
  if (steps === undefined) return undefined;
  let current: Json = value;
  for (const step of steps) {
    const inside = typeof current === 'string' ? parsedJson(current) : current;
    if (Array.isArray(inside)) {
      if (!/^\d+$/.test(step)) return undefined;
      const item = inside[Number(step)];
      if (item === undefined) return undefined;
      current = item;
    } else if (inside !== null && inside !== undefined && typeof inside === 'object') {
      if (!Object.hasOwn(inside, step)) return undefined;
      const field = inside[step];
      if (field === undefined) return undefined;
      current = field;
    } else {
      return undefined;
    }
  }
  return { value: current };
}

/** A cite as the model wrote it, numbered: what streams to the browser the moment its closing tag arrives. */
export const StreamedCite = z.object({
  /** Its place among the message's cites, from 1: the marker in the text names it. */
  index: z.number().int().min(1),
  /** Its number in the chat (`[n]`), counted across the history. */
  number: z.number().int().min(1),
  /** The tool id as the model wrote it: a run id, or a tool call id. */
  tool: z.string(),
  /** The JSON path into that call's result, as written ('' is the whole result). */
  path: z.string(),
  /** The model's words for how the value is evidence. */
  note: z.string(),
});
export type StreamedCite = z.infer<typeof StreamedCite>;

/** Where a cite's path was found: the run's result, or the result as the model read it (a table's rows, say). */
export const CiteFound = z.enum(['result', 'reply']);
export type CiteFound = z.infer<typeof CiteFound>;

/**
 * A cite of a settled message. Resolved when `problem` is absent: `run` is the run it cites and `value` the value at
 * its path (left out when larger than the hub keeps, `large`; the run's result still has it).
 */
export const Citation = StreamedCite.extend({
  run: RunId.optional(),
  fn: QualifiedName.optional(),
  found: CiteFound.optional(),
  value: Json.optional(),
  large: z.literal(true).optional(),
  /** Why it doesn't resolve, in plain words: no such tool call, or no value at that path. */
  problem: z.string().optional(),
});
export type Citation = z.infer<typeof Citation>;

/**
 * What a chat's model has been told about citations (`Session.citationsTold`): `prompt` is whether the system prompt
 * carries the citation rule (fixed at the chat's first turn, so the prompt caches), `on` whether citations were on as of
 * the last message. A message that finds the setting changed says so in a hidden `<citations_changed>` block.
 */
export const CitationsTold = z.object({ prompt: z.boolean(), on: z.boolean() });
export type CitationsTold = z.infer<typeof CitationsTold>;
