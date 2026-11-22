/**
 * What the model is told about citations ("Use citations", `Session.citations`). On from a chat's first turn, the rule
 * is in the fixed part of the system prompt (`citationsPrompt`), so the prompt caches; turned on or off later, the next
 * user message starts with a hidden `<citations_changed>` block (`citationsNotice`), once per change, undone with the
 * turn. While it is on, every tool result the model reads starts with its id (`citeIdLine`), which is what a cite names.
 *
 * Kept apart from the base system prompt's prose, which is written elsewhere: the prompt includes this as it is.
 */
import type { CitationsTold, RunId, Session } from '@harness/core';

/** The tag the mid-chat change is told in. */
export const CITATIONS_CHANGED_TAG = 'citations_changed';

/** The words before a tool result's id, on its first line. */
export const TOOL_ID_LABEL = 'tool id:';

/** A tool result's first line while citations are on: its id, which a cite names. */
export function citeIdLine(run: RunId): string {
  return `${TOOL_ID_LABEL} ${run}`;
}

/** A tool result as the model reads it while citations are on: its id first. */
export function withCiteId(run: RunId, content: string): string {
  return `${citeIdLine(run)}\n${content}`;
}

/** The citation rule, for a model that knows nothing about this app. */
export const CITATION_RULE = [
  '<citations>',
  'Cite your work. Each claim you make from a tool result is followed by a cite of the value it comes from:',
  '<cite tool="TOOL_ID" path="PATH">how this value supports the claim</cite>',
  `- TOOL_ID is the id on the first line of that tool result ("${TOOL_ID_LABEL} run_…"), copied exactly.`,
  '- PATH is the JSON path to the value in that result that is the evidence: keys and array positions (from 0) joined by dots, such as results.0.title, rows.3 or items.2.due. Use path="" to cite the whole result.',
  '- The words inside say briefly how that value backs the claim; the person reads them when they open the cite.',
  'Example: The report is due Friday <cite tool="run_7Hq2xk" path="items.0.due">the first item is due 2026-11-27, a Friday</cite>.',
  'Cite only results of tool calls in this chat, never what you know otherwise. A claim with no tool result behind it gets no cite.',
  '</citations>',
].join('\n');

/** What the system prompt's fixed part carries for citations: the rule when they were on at the chat's first turn. */
export function citationsPrompt(session: Pick<Session, 'citations' | 'citationsTold'> | undefined): string {
  if (session === undefined) return '';
  return (session.citationsTold?.prompt ?? session.citations === true) ? CITATION_RULE : '';
}

/** Told when citations go on after the chat's first turn: the rule itself. */
export const CITATIONS_ON = `Citations are on from this message.\n${CITATION_RULE}`;

/** Told when citations go back on while the system prompt has the rule. */
export const CITATIONS_ON_AGAIN = 'Citations are on again from this message: cite your work as the <citations> rule in the system prompt says.';

/** Told when citations go off. */
export const CITATIONS_OFF = 'Citations are off from this message: write no more <cite> tags.';

/**
 * What a new user message tells the model about citations, and the record after it. The first message records the
 * setting (the system prompt says it); a later one whose setting differs from what was last told says the change.
 */
export function citationsNotice(told: CitationsTold | undefined, on: boolean): { notice?: string; told: CitationsTold } {
  if (told === undefined) return { told: { prompt: on, on } };
  if (told.on === on) return { told };
  const words = !on ? CITATIONS_OFF : told.prompt ? CITATIONS_ON_AGAIN : CITATIONS_ON;
  return { notice: `<${CITATIONS_CHANGED_TAG}>\n${words}\n</${CITATIONS_CHANGED_TAG}>`, told: { ...told, on } };
}
