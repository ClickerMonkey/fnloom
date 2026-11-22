/**
 * The API index (build 8, `core/api-index.ts`; Decided "Context folders"): for every system with fns, one context item
 * `<system>/api` listing its groups as choices, and one `<system>/api.<group>` per group listing that group's fns one
 * line each (and bringing them when loaded). A small model walks the API the way it walks a context folder: the index,
 * a group, a fn. The catalog writes them in the same transaction as the fns they list, from the manifest it is
 * importing, so they never drift from the fns.
 */
import {
  apiContextLocal, apiContextName, GENERAL_GROUP, qualify,
  type ApiGroupDecl, type ContextDecl, type FnDecl, type QualifiedName, type SystemName,
} from '@harness/core';

/** The most characters a fn's line gives its description. */
const LINE = 160;

/** The first sentence of a description, cut to one line. */
function oneLine(text: string): string {
  const first = text.split(/(?<=[.!?])\s|\n/, 1)[0] ?? text;
  return first.length > LINE ? `${first.slice(0, LINE - 1)}…` : first;
}

/** The groups a system's fns fall in, in the order the manifest describes them, then any it names without describing. */
function groupsOf(system: SystemName, fns: readonly FnDecl[], declared: readonly ApiGroupDecl[]): ApiGroupDecl[] {
  const used = new Set(fns.map((fn) => fn.group ?? GENERAL_GROUP));
  const described = declared.filter((group) => used.has(group.name));
  const known = new Set(described.map((group) => group.name));
  const rest = [...used].filter((name) => !known.has(name)).sort().map((name): ApiGroupDecl => ({
    name, title: name === GENERAL_GROUP ? 'General' : name, description: name === GENERAL_GROUP ? `${system}'s fns that are in no other group.` : `${system}'s ${name} fns.`,
  }));
  return [...described, ...rest];
}

/**
 * A generated context item's fixed parts: hub-written, for the model, never suggested by itself, and `reference`
 * material (`Niche`): its fns are hits of their own, so a search ranks the listing below them.
 */
function item(name: string, description: string, content: string, extra: Partial<ContextDecl>): ContextDecl {
  return {
    name, description, content, imports: [], fns: [], suggestFns: [], suggest: 'none', visible: 'both', tags: ['api'], niche: 'reference', ...extra,
  };
}

/**
 * The API index items of one system's fns: none for a system without fns the model may call. Fns only people see
 * (`visibility: 'user'`) are left out, as the model can't call them.
 */
export function apiIndexDecls(system: SystemName, fns: readonly FnDecl[], declared: readonly ApiGroupDecl[]): ContextDecl[] {
  const callable = fns.filter((fn) => fn.visibility !== 'user');
  if (callable.length === 0) { return []; }
  const groups = groupsOf(system, callable, declared);
  const index: QualifiedName = apiContextName(system);
  const out: ContextDecl[] = [];
  for (const group of groups) {
    const members = callable.filter((fn) => (fn.group ?? GENERAL_GROUP) === group.name).sort((a, b) => a.name.localeCompare(b.name));
    const names = members.map((fn) => qualify(system, fn.name));
    const lines = members.map((fn) => `- \`${qualify(system, fn.name)}\`: ${oneLine(fn.description)}`);
    out.push(item(apiContextLocal(group.name), `${system} API, ${group.title}: ${group.description}`, [`# ${system} API: ${group.title}`, '', group.description, '', ...lines].join('\n'), {
      title: `${system} API: ${group.title}`, fns: names, parent: index, summary: `${String(members.length)} ${system} fns: ${group.description}`,
    }));
  }
  const listing = groups.map((group) => `- **${group.title}** (\`${apiContextName(system, group.name)}\`): ${group.description}`);
  out.unshift(item(apiContextLocal(), `The ${system} API: its fns in ${String(groups.length)} groups. Load a group to see and use its fns.`, [`# ${system} API`, '', `Its ${String(callable.length)} fns, by group. Load a group to see each fn in one line and to be able to call them.`, '', ...listing].join('\n'), {
    title: `${system} API`,
    choices: groups.map((group) => ({ to: apiContextName(system, group.name), when: oneLine(`You need ${system}'s ${group.title.toLowerCase()} fns: ${group.description}`).slice(0, 200) })),
  }));
  return out;
}

/** Whether a context item is one of a system's API index items (`<system>/api`, `<system>/api.<group>`). */
export function isApiIndexName(system: SystemName, name: string): boolean {
  return name === apiContextName(system) || name.startsWith(`${apiContextName(system)}.`);
}
