/**
 * robots.txt for crawls: the rules of the group that names the crawler's agent token (else the `*` group), matched
 * the way Google documents it: the longest matching `Allow` or `Disallow` path wins, `Allow` on a tie, `*` matches
 * anything and a trailing `$` ends the path. A site with no robots.txt (or one that can't be read) allows everything.
 */

/** One rule of a group. */
interface Rule {
  readonly allow: boolean;
  readonly path: string;
  readonly pattern: RegExp;
}

/** A site's robots.txt rules for one agent. */
export class RobotsRules {
  /** Rules that allow everything (no robots.txt). */
  static readonly ALLOW_ALL = new RobotsRules([]);

  readonly #rules: readonly Rule[];

  private constructor(rules: readonly Rule[]) {
    this.#rules = rules;
  }

  /** Parse a robots.txt for the agent token (`harness-web`). */
  static parse(text: string, agent: string): RobotsRules {
    const token = agent.toLowerCase();
    const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
    let current: { agents: string[]; rules: Rule[] } | undefined;
    let inAgents = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const colon = line.indexOf(':');
      if (colon < 0) { continue; }
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (field === 'user-agent') {
        if (current === undefined || !inAgents) { current = { agents: [], rules: [] }; groups.push(current); }
        current.agents.push(value.toLowerCase());
        inAgents = true;
      } else if (field === 'allow' || field === 'disallow') {
        inAgents = false;
        // an empty Disallow allows everything: it adds no rule
        if (current !== undefined && value !== '') { current.rules.push(rule(field === 'allow', value)); }
      } else {
        inAgents = false;
      }
    }
    const named = groups.filter((group) => group.agents.some((name) => name !== '*' && token.startsWith(name)));
    const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
    return new RobotsRules(chosen.flatMap((group) => group.rules));
  }

  /** Whether a URL's path (and query) may be fetched. */
  allows(url: URL): boolean {
    const path = `${url.pathname}${url.search}`;
    let best: Rule | undefined;
    for (const candidate of this.#rules) {
      if (!candidate.pattern.test(path)) { continue; }
      if (best === undefined || candidate.path.length > best.path.length || (candidate.path.length === best.path.length && candidate.allow)) { best = candidate; }
    }
    return best?.allow ?? true;
  }
}

function rule(allow: boolean, path: string): Rule {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).split('*').map(escapeRegExp).join('.*');
  return { allow, path, pattern: new RegExp(`^${body}${anchored ? '$' : ''}`) };
}

/** A string as a literal in a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
