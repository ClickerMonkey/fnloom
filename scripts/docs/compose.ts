/**
 * Composes the authoring guide: one markdown document of topics in an author's order, each its hand-written prose
 * (`prose/<id>.md`) followed by the reference of the exports the outline places there, then the appendix of reached
 * core types. Prose pulls in compiled source with include directives and generated blocks with generate directives:
 *
 * - `<!-- include: path -->` or `<!-- include: path#region -->`: a file of the repository (or one `// #region name` …
 *   `// #endregion name` part of it) as a fenced block. Region marker lines never appear in the output.
 * - `<!-- generate: name -->`: the text of the named generator (the hub contract, the `system.json` schema, …).
 *
 * Composition is strict, so nothing goes undocumented or stale: an export the outline doesn't place, a placed name that
 * isn't exported, a name placed twice, a missing prose file, an unknown directive, a missing region, and a generator
 * no prose uses each fail with every problem listed.
 */
import type { ApiItem, ApiModel } from './extract.ts';

/** One section of the guide. */
export interface Topic {
  /** The anchor and the prose file's name (`prose/<id>.md`). */
  readonly id: string;
  readonly title: string;
  /** Exports documented in this topic's reference, in this order. */
  readonly exports: readonly string[];
  /** External declarations (`ApiModel.external`) documented here, by name. */
  readonly external?: readonly string[];
  /** Whether the core types its exports refer to go in the core types appendix. Default true; internals say false. */
  readonly reach?: boolean;
}

/** Everything composition reads, as seams, so tests run it over fixtures. */
export interface ComposeInput {
  readonly title: string;
  /** The lines under the title: what the document is and how it is made. */
  readonly intro: string;
  readonly outline: readonly Topic[];
  readonly api: ApiModel;
  /** A topic's prose, by topic id; undefined when the file is missing. */
  readonly prose: (id: string) => string | undefined;
  /** A file of the repository by its repository-relative path; undefined when it is missing. */
  readonly file: (path: string) => string | undefined;
  /** Generated blocks by name. */
  readonly generators: Readonly<Record<string, () => string>>;
}

/** Composition found problems; every one is listed. */
export class GuideProblems extends Error {
  override readonly name = 'GuideProblems';
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The authoring guide can't be composed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const DIRECTIVE = /^<!--\s*(include|generate):\s*(\S+?)\s*-->$/gm;
const REGION_START = /^\s*\/\/\s*#region\s+(\S+)\s*$/;
const REGION_END = /^\s*\/\/\s*#endregion(?:\s+\S+)?\s*$/;

/** A heading's anchor as GitHub makes it: lowercase, punctuation dropped, each space a dash. */
export function anchor(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
}

/** The fenced-code language for a file. */
function languageOf(path: string): string {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const languages: Record<string, string> = { ts: 'ts', vue: 'vue', json: 'json', md: 'md', js: 'js', sh: 'sh' };
  return languages[extension] ?? 'text';
}

/** A fenced block around text, its fence longer than any run of backticks inside. */
export function fence(text: string, language: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${language}\n${text.replace(/\n+$/, '')}\n${marks}`;
}

/** A markdown table; a `|` inside a cell is escaped so it can't split the cell. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`;
  return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

/**
 * One region of a source file (`// #region name` … `// #endregion`), or the whole file, without region marker lines
 * and with the region's common indent removed. Undefined when the region isn't there.
 */
export function regionOf(source: string, region: string | undefined): string | undefined {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const isMarker = (line: string) => REGION_START.test(line) || REGION_END.test(line);
  if (region === undefined) { return lines.filter((line) => !isMarker(line)).join('\n'); }
  const start = lines.findIndex((line) => REGION_START.exec(line)?.[1] === region);
  if (start < 0) { return undefined; }
  const body: string[] = [];
  let depth = 0;
  for (const line of lines.slice(start + 1)) {
    if (REGION_START.test(line)) { depth += 1; continue; }
    if (REGION_END.test(line)) {
      if (depth === 0) { break; }
      depth -= 1;
      continue;
    }
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
  return body.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/**
 * The API with only the reached types that topics which reach (`Topic.reach`, default true) refer to, so internals don't
 * pull wire shapes an author never writes into the appendix. Each item's `reaches` is pruned to match.
 */
export function pruneReached(api: ApiModel, outline: readonly Topic[]): ApiModel {
  const reaching = new Set(outline.filter((topic) => topic.reach !== false).flatMap((topic) => [...topic.exports, ...(topic.external ?? [])]));
  const kept = new Set([...api.exports, ...api.external].filter((item) => reaching.has(item.name)).flatMap((item) => item.reaches));
  const prune = (item: ApiItem): ApiItem => ({ ...item, reaches: item.reaches.filter((name) => kept.has(name)) });
  return {
    exports: api.exports.map(prune),
    external: api.external.map(prune),
    reached: api.reached.filter((item) => kept.has(item.name)).map(prune),
  };
}

/** Render one reference item: heading, where it comes from, its docs, its declaration and what it refers to. */
function renderItem(item: ApiItem, reached: ReadonlySet<string>): string {
  const origin = item.module.startsWith('@') ? `\`import { ${item.name} } from '${item.module}'\`` : `declared in \`${item.file}\``;
  const refs = item.reaches.filter((name) => reached.has(name)).map((name) => `[\`${name}\`](#${anchor(`core-${name}`)})`);
  return [
    `#### \`${item.name}\``,
    `${item.kinds.join(', ')} · ${origin}`,
    item.docs,
    fence(item.code, 'ts'),
    refs.length === 0 ? '' : `Refers to: ${refs.join(', ')}.`,
  ].filter((part) => part !== '').join('\n\n');
}

/** The core types reached from the exports, each under its own anchor. */
export function renderReached(api: ApiModel): string {
  const reached = new Set(api.reached.map((item) => item.name));
  return api.reached.map((item) => {
    const body = renderItem(item, reached).replace(/^#### `[^`]+`/, `#### <a id="${anchor(`core-${item.name}`)}"></a>\`${item.name}\``);
    return body;
  }).join('\n\n');
}

/** Compose the guide. Throws `GuideProblems` listing everything wrong. */
export function composeGuide(input: ComposeInput): string {
  const problems: string[] = [];
  const exports = new Map(input.api.exports.map((item) => [item.name, item]));
  const external = new Map(input.api.external.map((item) => [item.name, item]));
  const reached = new Set(input.api.reached.map((item) => item.name));

  // every export placed exactly once, and only exports placed
  const placed = new Map<string, string>();
  for (const topic of input.outline) {
    for (const name of topic.exports) {
      const earlier = placed.get(name);
      if (earlier !== undefined) { problems.push(`${name} is placed in both ${earlier} and ${topic.id}`); }
      placed.set(name, topic.id);
      if (!exports.has(name)) { problems.push(`${topic.id} places ${name}, which is not exported (remove it from the outline)`); }
    }
    for (const name of topic.external ?? []) {
      if (!external.has(name)) { problems.push(`${topic.id} places external ${name}, which was not extracted`); }
    }
  }
  const unplaced = [...exports.keys()].filter((name) => !placed.has(name));
  if (unplaced.length > 0) { problems.push(`exports no topic places (add each to a topic in scripts/docs/outline.ts): ${unplaced.join(', ')}`); }

  const used = new Set<string>();
  const expand = (topic: string, text: string): string => text.replace(DIRECTIVE, (_all, verb: string, target: string) => {
    if (verb === 'generate') {
      const generate = input.generators[target];
      if (generate === undefined) { problems.push(`${topic} asks for generator ${target}, which doesn't exist`); return ''; }
      used.add(target);
      return generate().replace(/\n+$/, '');
    }
    const [path = '', region] = target.split('#');
    const source = input.file(path);
    if (source === undefined) { problems.push(`${topic} includes ${path}, which doesn't exist`); return ''; }
    const part = regionOf(source, region);
    if (part === undefined) { problems.push(`${topic} includes ${target}, but ${path} has no region ${region ?? ''}`); return ''; }
    // say where it is from, so a reader can find the whole file in the worked examples
    return `_From \`${path}\`:_\n\n${fence(part, languageOf(path))}`;
  });

  const sections = input.outline.map((topic, index) => {
    const prose = input.prose(topic.id);
    if (prose === undefined) { problems.push(`${topic.id} has no prose file (prose/${topic.id}.md)`); }
    const items = [
      ...topic.exports.flatMap((name) => { const item = exports.get(name); return item === undefined ? [] : [item]; }),
      ...(topic.external ?? []).flatMap((name) => { const item = external.get(name); return item === undefined ? [] : [item]; }),
    ];
    const reference = items.length === 0 ? '' : `### Reference: ${topic.title.toLowerCase()}\n\n${items.map((item) => renderItem(item, reached)).join('\n\n')}`;
    return [`## ${index + 1}. ${topic.title}`, expand(topic.id, (prose ?? '').replaceAll('\r\n', '\n').trim()), reference].filter((part) => part !== '').join('\n\n');
  });

  const unused = Object.keys(input.generators).filter((name) => !used.has(name));
  if (unused.length > 0) { problems.push(`generators no prose uses (add <!-- generate: name --> or remove them): ${unused.join(', ')}`); }
  if (problems.length > 0) { throw new GuideProblems(problems); }

  const contents = input.outline.map((topic, index) => `${index + 1}. [${topic.title}](#${anchor(`${index + 1}. ${topic.title}`)})`).join('\n');
  return `${[`# ${input.title}`, input.intro.trim(), '## Contents', contents, ...sections].join('\n\n')}\n`;
}
