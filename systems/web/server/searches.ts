/**
 * A web search kept as a hub resource: its results as one markdown page (the query, Tavily's short answer when there
 * is one, then each result's title as a link, its snippet and when it was published), so a search can be read again,
 * searched and made into context like any page the chat read.
 */
import type { SearchFoundValue } from '../shared/index.ts';

/** The page a search is kept as: its name and markdown. */
export interface SearchPage {
  readonly name: string;
  readonly markdown: string;
}

/** Text as one markdown line: no line breaks, and the characters that would start markup escaped. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/([\\[\]*_`<>#])/g, '\\$1');
}

/** The page a search's results are kept as. `at` is when it ran (an ISO date and time). */
export function searchPage(query: string, results: SearchFoundValue, at: string): SearchPage {
  const lines = [`# Web search: ${inline(query)}`, '', `Searched ${at}. ${results.results.length} ${results.results.length === 1 ? 'result' : 'results'}, best first.`, ''];
  if (results.answer !== undefined) { lines.push('## Short answer', '', inline(results.answer), ''); }
  results.results.forEach((hit, index) => {
    lines.push(`## ${index + 1}. [${inline(hit.title)}](${hit.url.replace(/[\s()]/g, (char) => encodeURIComponent(char))})`, '');
    if (hit.published !== undefined) { lines.push(`Published ${inline(hit.published)}.`, ''); }
    lines.push(inline(hit.snippet), '');
  });
  return { name: `Web search: ${query.replace(/\s+/g, ' ').trim().slice(0, 80)}`, markdown: `${lines.join('\n').trimEnd()}\n` };
}
