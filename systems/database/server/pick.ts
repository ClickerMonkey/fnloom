/**
 * Which database a request is for (`pick_database`, get_query's first step). The database the request names, else the
 * only one the person may use, else the admin's decision model chooses between them (`ctx.decide`), each described by
 * its label and tables and scored by how many of the request's words its tables match. With the decision model off or
 * failed the scores decide, when the best one leads clearly. Otherwise the person is asked which one.
 */
import type { DecideAnswer, DecideCandidate } from '@harness/core';
import type { DatabasePick } from '../shared/shapes.ts';
import type { FleetMember } from './impl.ts';

/** What picking needs: the request, the databases the person may use, and the decision model. */
export interface PickInput {
  readonly description: string;
  readonly asked?: string | undefined;
  readonly members: readonly FleetMember[];
  decide(question: string, candidates: readonly DecideCandidate[]): Promise<DecideAnswer>;
}

/** The pick thresholds (`DATABASE_PICK_MIN`, `DATABASE_PICK_MARGIN`). */
export interface PickLimits {
  readonly min: number;
  readonly margin: number;
}

/** A word's plain form for matching: lower case, a trailing plural `s` dropped (`Invoices` matches `invoice`). */
function stem(word: string): string {
  const lower = word.toLowerCase();
  return lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss') ? lower.slice(0, -1) : lower;
}

/** The distinct words of a text worth matching (three letters or more), each split on `_` and stemmed. */
export function wordsOf(text: string): Set<string> {
  return new Set((text.match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []).map(stem));
}

/** How much of the request a database's label and tables cover: the share of the request's words they hold, 0 to 1. */
export function matchScore(request: ReadonlySet<string>, member: FleetMember): number {
  if (request.size === 0) { return 0; }
  const held = wordsOf([member.label, ...member.tables].join(' ').replaceAll('_', ' '));
  let hits = 0;
  for (const word of request) { if (held.has(word)) { hits += 1; } }
  return hits / request.size;
}

/** The question for the person, by label. */
function askWhich(members: readonly FleetMember[]): DatabasePick {
  const labels = members.map((member) => member.label);
  const listed = labels.length <= 2 ? labels.join(' or ') : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1) ?? ''}`;
  return { ask: `Which database: ${listed}?`, databases: members.map((member) => member.instance) };
}

/** Pick the database a request is for, or say what to ask. A named database the person may not use (or that does not exist) is refused. */
export async function pickDatabase(input: PickInput, limits: PickLimits): Promise<DatabasePick | { invalid: string }> {
  const { members } = input;
  if (input.asked !== undefined) {
    const name = input.asked.replace(/^database\//, '');
    const named = members.find((member) => member.instance === name || member.label.toLowerCase() === name.toLowerCase());
    if (named !== undefined) { return { database: named.instance, label: named.label, by: 'asked', why: `The request names the ${named.label} database.` }; }
    if (members.length === 0) { return { invalid: `There is no database "${input.asked}" you may use.` }; }
    return { invalid: `There is no database "${input.asked}" you may use; these are: ${members.map((member) => `${member.instance} (${member.label})`).join(', ')}.` };
  }
  const [only, second] = members;
  if (only === undefined) { return { invalid: 'There is no database you may use; an admin chooses who may use each on its config.' }; }
  if (second === undefined) { return { database: only.instance, label: only.label, by: 'only', why: `${only.label} is the only database you may use.` }; }
  const request = wordsOf(input.description);
  const scored = members.map((member) => ({ member, score: matchScore(request, member) })).sort((a, b) => b.score - a.score);
  const candidates: DecideCandidate[] = scored.map(({ member, score }) => ({
    id: member.instance,
    text: `${member.label} database: ${member.tables.length === 0 ? 'no tables yet' : member.tables.join('; ')}`,
    score,
  }));
  const decided = await input.decide(`Which database answers this request: "${input.description}"? Pick none when it could be more than one.`, candidates);
  if (decided.by === 'decision') {
    const [pick] = decided.picked;
    const member = members.find((found) => found.instance === pick?.id);
    if (member !== undefined) { return { database: member.instance, label: member.label, by: 'decision', why: pick?.why ?? `The decision model picked ${member.label}.` }; }
    return askWhich(scored.map(({ member: found }) => found));
  }
  const [best, next] = scored;
  if (best !== undefined && best.score >= limits.min && best.score - (next?.score ?? 0) >= limits.margin) {
    return { database: best.member.instance, label: best.member.label, by: 'score', why: `${best.member.label}'s tables match the request best.` };
  }
  return askWhich(scored.map(({ member }) => member));
}
