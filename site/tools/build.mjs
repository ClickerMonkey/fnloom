// Builds the site: site/src → site/dist.
//
//   node site/tools/build.mjs
//
// Every text file in src is copied with its {{tokens}} filled from site/site.config.json, so the product's name lives
// in exactly one place (change "name" there and rebuild). HTML files can also hold <!-- build:part --> markers, filled
// from their single sources:
//
//   docs/site/feature-matrix.md          the comparison (matrix, column chips, "haven't found elsewhere")
//   docs/site/research/competitors.md    the sources under "How we compared", by product
//   site/data/marketplace.json           the mock marketplace's listings
//   docs/install.md, docs/using.md       the guide (site/src/docs)
//
// dist/ is what gets hosted (DigitalOcean static site; see site/README.md). It is not checked in.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Marked from 'marked';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');
const src = join(site, 'src');
const dist = join(site, 'dist');
const config = JSON.parse(readFileSync(join(site, 'site.config.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------- tokens
const TOKENS = {
  name: config.name,
  tagline: config.tagline,
  domain: config.domain || '',
  year: String(new Date().getFullYear()),
  topic: `${slug(config.name)}-system`,
  contact: config.contact || '',
  package: config.package || '',
  repo: config.repo || '',
};
// The harness's own words, always underlined and defined on hover, focus or tap ({{fn}}, {{fns}}, {{system}} …, in
// HTML only). Phil: "Use fn and fns not the spelled out word so they learn about it … always have a hover. And separate
// systems and functions they are separate things that need separate descriptions."
const list = (items) => `<span class="tip-list">${items.map((i) => `<span>${i}</span>`).join('')}</span>`;
const DEFS = {
  fn: `<b class="tip-head">fn <i>(fns)</i></b>What ${esc(config.name)} acts with. Like a tool, but every fn also:${list([
    'has typed inputs and results',
    'shows its status live, with steps and progress',
    'can be cancelled, paused, resumed or undone',
    'says whether it reads or changes things; changes can ask first',
    'calls only the fns it declares',
    'keeps every version, and is private or shared',
    'comes in kinds; a saved fn runs without a model',
  ])}`,
  system: `<b class="tip-head">system <i>(systems)</i></b>A plug-in that connects to the hub from any computer you own. Each one brings:${list([
    'fns, and kinds to make more fns',
    'context: guides and rules it can load',
    'its own screens in the app',
    'its own settings and keys',
  ])}An admin reviews every system before it goes live.`,
  kind: `<b class="tip-head">kind <i>(kinds)</i></b>A recipe for making fns: code programs, saved database queries, API requests, schedules, forms and charts are kinds. Any system can add a kind; it works out a new fn’s inputs, permissions and progress, so making one takes only a name and a description.`,
};
const TERMS = { fn: ['fn', 'fn'], fns: ['fn', 'fns'], system: ['system', 'system'], systems: ['system', 'systems'], kind: ['kind', 'kind'], kinds: ['kind', 'kinds'] };
let termId = 0;
const term = (def, word) => {
  termId++;
  return `<span class="term w-${def}" tabindex="0" aria-describedby="d${termId}">${word}<span class="tip" role="tooltip" id="d${termId}">${DEFS[def]}</span></span>`;
};
/** Wraps the words fn and fns in already-built HTML text (matrix labels, the "elsewhere" list). */
const termify = (html) => html.replace(/\b(fns?)\b/g, (w) => term('fn', w));

const fill = (text, escape) => text.replace(/\{\{(\w+)\}\}/g, (all, key) => {
  if (escape && key in TERMS) { return term(...TERMS[key]); }
  if (!(key in TOKENS)) { throw new Error(`unknown token ${all}`); }
  return escape ? esc(TOKENS[key]) : TOKENS[key];
});

// ---------------------------------------------------------------- the comparison
/** Every column the matrix may have, by the label its markdown header uses. `src` is the product's sources id. */
const KNOWN = {
  Harness: { key: 'us', label: config.name, sub: 'this project' },
  OpenCode: { key: 'opencode', label: 'OpenCode' },
  Claude: { key: 'claude', label: 'Claude', sub: 'Code + apps' },
  herdr: { key: 'herdr', label: 'herdr' },
  OpenClaw: { key: 'openclaw', label: 'OpenClaw' },
  Hermes: { key: 'hermes', label: 'Hermes', sub: 'Agent' },
  Codex: { key: 'codex', label: 'Codex', sub: '+ ChatGPT' },
  'Open WebUI': { key: 'openwebui', label: 'Open WebUI' },
  goose: { key: 'goose', label: 'goose' },
  n8n: { key: 'n8n', label: 'n8n' },
  pi: { key: 'pi', label: 'pi' },
};
const SYMBOLS = {
  '●': { cls: 'yes', text: 'Yes' },
  '◐': { cls: 'part', text: 'Partly' },
  '○': { cls: 'no', text: 'No' },
  '–': { cls: 'na', text: 'Not in their docs, or doesn’t apply' },
  '◇': { cls: 'soon', text: 'Coming soon' },
  '?': { cls: 'tbd', text: 'Not decided yet' },
};
/** Notes written for reviewers in the matrix, shown on the page in plain words. */
const NOTE_TEXT = { owner: 'not decided yet' };

const rowsOf = (table) => table.split('\n').filter((l) => l.startsWith('|'))
  .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()));

function comparison() {
  const md = readFileSync(join(repo, 'docs', 'site', 'feature-matrix.md'), 'utf8');
  const sections = [];
  let only = [];
  let columns = null;
  for (const block of md.split(/\n## /).slice(1)) {
    const [titleLine, ...rest] = block.split('\n');
    const body = rest.join('\n');
    const at = body.indexOf('\n|');
    if (at === -1) { continue; }
    const table = body.slice(at + 1).split('\n\n')[0];
    const rows = rowsOf(table);
    const title = titleLine.trim();
    if (title.startsWith('Only here')) { only = rows.slice(2); continue; }
    const head = rows[0].slice(1);
    const cols = head.map((h) => {
      const c = KNOWN[h];
      if (c === undefined) { throw new Error(`feature-matrix.md: unknown column "${h}"`); }
      return { ...c, md: h };
    });
    if (columns === null) { columns = cols; }
    else if (cols.map((c) => c.key).join() !== columns.map((c) => c.key).join()) { throw new Error(`feature-matrix.md: "${title}" has different columns`); }
    // "## 1. Title — lede" : the number orders nothing (the file's order is the page's), the lede shows under it
    const [name, lede] = title.replace(/^\d+\.\s*/, '').split(/\s+—\s+/);
    sections.push({ title: name, lede: lede ?? '', rows: rows.slice(2) });
  }

  const cell = (raw, col) => {
    const first = [...raw][0];
    const symbol = SYMBOLS[first];
    const us = col.key === 'us' ? ' class="us"' : '';
    if (symbol === undefined) { return `<td data-col="${col.key}"${us}><span class="txt">${esc(raw)}</span></td>`; }
    const note = raw.slice(first.length).trim();
    const shown = NOTE_TEXT[note] ?? note;
    const noteHtml = shown === '' ? '' : ` <span class="note">${esc(shown)}</span>`;
    const symHtml = first === '?' ? '' : `<span class="sym ${symbol.cls}" aria-hidden="true">${first}</span>`;
    const label = first === '?' ? '' : `<span class="vh">${symbol.text}${shown === '' ? '' : ', '}</span>`;
    return `<td data-col="${col.key}"${us} data-v="${symbol.cls}">${symHtml}${label}${noteHtml}</td>`;
  };

  const colHead = columns.map((c) => {
    const sub = c.sub === undefined ? '' : `<span class="sub">${esc(c.sub)}</span>`;
    const href = c.key === 'us' ? '#how' : `#src-${c.key}`;
    return `<th scope="col" data-col="${c.key}"${c.key === 'us' ? ' class="us"' : ''}><a href="${href}">${esc(c.label)}${sub}</a></th>`;
  }).join('');

  let matrix = `<table class="matrix" id="matrix-table">
<caption class="vh">Features of ${esc(config.name)} and ${columns.length - 1} other AI agent harnesses and apps, grouped by category, strongest first. Each cell says yes, partly, no, or not found.</caption>
<thead><tr><th scope="col" class="feat">Feature</th>${colHead}</tr></thead>\n`;
  sections.forEach((s, i) => {
    const lede = s.lede === '' ? '' : `<small>${esc(s.lede)}</small>`;
    matrix += `<tbody id="cat-${slug(s.title)}"><tr class="cat"><th scope="colgroup" colspan="${columns.length + 1}"><span><b>${String(i + 1).padStart(2, '0')}</b> ${esc(s.title)}${lede}</span></th></tr>\n`;
    for (const r of s.rows) {
      matrix += `<tr><th scope="row" class="feat">${termify(esc(r[0]))}</th>${r.slice(1).map((c, j) => cell(c, columns[j])).join('')}</tr>\n`;
    }
    matrix += '</tbody>\n';
  });
  matrix += '</table>';

  const chips = columns.filter((c) => c.key !== 'us')
    .map((c) => `<label class="chip"><input type="checkbox" data-toggle="${c.key}" checked> ${esc(c.label)}</label>`).join('\n');
  const onlyHtml = `<ul class="only-list">\n${only.map(([t, d], i) => `<li data-reveal style="--i:${i}"><h3>${termify(esc(t))}</h3><p>${termify(esc(d))}</p></li>`).join('\n')}\n</ul>`;
  const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
  return { matrix, chips, only: onlyHtml, columns, summary: `${sections.length} categories, ${rowCount} rows, ${columns.length} columns, ${only.length} "elsewhere" items` };
}

// ---------------------------------------------------------------- sources, by product, from competitors.md
function sources(columns) {
  const md = readFileSync(join(repo, 'docs', 'site', 'research', 'competitors.md'), 'utf8');
  const defs = new Map();
  for (const m of md.matchAll(/^\[\^(\d+)\]:\s*(.+?):\s*(https?:\/\/\S+)\s*$/gm)) { defs.set(m[1], { label: m[2], url: m[3] }); }
  const byProduct = new Map();
  for (const block of md.split(/\n## /).slice(1)) {
    const title = block.split('\n')[0];
    const m = title.match(/^\d+\.\s*(.+)$/);
    if (!m) { continue; }
    const col = columns.find((c) => c.key !== 'us' && m[1].toLowerCase().startsWith(c.md.toLowerCase()));
    if (!col) { continue; }
    const refs = [...new Set([...block.matchAll(/\[\^(\d+)\]/g)].map((r) => r[1]))].filter((n) => defs.has(n));
    byProduct.set(col.key, refs.map((n) => defs.get(n)));
  }
  return columns.filter((c) => c.key !== 'us').map((c) => {
    const list = byProduct.get(c.key) ?? [];
    const items = list.map((s) => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.label)}</a></li>`).join('');
    return `<section id="src-${c.key}" aria-labelledby="h-src-${c.key}"><h3 id="h-src-${c.key}">${esc(c.label)}</h3><ul>${items}</ul></section>`;
  }).join('\n');
}

// ---------------------------------------------------------------- the mock marketplace
function marketplace() {
  const file = join(site, 'data', 'marketplace.json');
  if (!existsSync(file)) { return null; }
  const data = JSON.parse(fill(readFileSync(file, 'utf8'), false));
  const cats = data.categories;
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const badge = (b) => `<span class="badge b-${b}">${esc(data.badges[b])}</span>`;
  const card = (s) => `<li class="m-card" data-id="${esc(s.id)}" data-cat="${esc(s.categories.join(' '))}" data-q="${esc([s.title, s.summary, s.publisher, ...s.categories, ...(s.fns ?? []).map((f) => f.label)].join(' ').toLowerCase())}">
  <a href="#s/${esc(s.id)}" class="m-hit" aria-label="${esc(s.title)}: details"></a>
  <span class="m-icon" style="--hue:${s.hue}" aria-hidden="true">${esc(s.glyph)}</span>
  <h3>${esc(s.title)}</h3>
  <p class="m-pub">${esc(s.publisher)}${s.example ? ' <span class="ex">example</span>' : ''}</p>
  <p class="m-sum">${termify(esc(s.summary))}</p>
  <p class="m-meta">${s.badges.map(badge).join('')}<span class="m-cat">${esc(catName[s.categories[0]])}</span></p>
</li>`;
  const grid = `<ul class="m-grid" id="m-grid">\n${data.systems.map(card).join('\n')}\n</ul>`;
  const chips = [`<button type="button" class="m-chip" aria-pressed="true" data-cat="">All <span>${data.systems.length}</span></button>`,
    ...cats.map((c) => `<button type="button" class="m-chip" aria-pressed="false" data-cat="${esc(c.id)}">${esc(c.name)} <span>${data.systems.filter((s) => s.categories.includes(c.id)).length}</span></button>`)].join('\n');
  const featured = data.featured.map((id) => data.systems.find((s) => s.id === id)).map((s, i) => `<li class="f-card" style="--hue:${s.hue};--i:${i}" data-reveal>
  <a href="#s/${esc(s.id)}"><span class="m-icon" aria-hidden="true">${esc(s.glyph)}</span><span class="f-text"><strong>${esc(s.title)}</strong><span>${esc(s.pitch ?? s.summary)}</span></span></a>
</li>`).join('\n');
  const fnTerm = `<template id="t-fns">${term('fn', 'fns')}</template>`;
  const json = fnTerm + `<script type="application/json" id="m-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
  return { grid, chips, featured, json, summary: `${data.systems.length} listings` };
}

// ---------------------------------------------------------------- copy src → dist
const TEXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml', '.webmanifest']);
// ---------------------------------------------------------------- the guide (site/src/docs): docs/install.md and docs/using.md
// Rendered with marked. Raw HTML in the markdown is shown as text (`<name>` placeholders), headings get ids, and links
// between the two files become links within the page.
const guide = (() => {
  const toc = [];
  const used = new Set();
  const uniqueId = (text) => { const base = slug(text); let id = base; for (let n = 2; used.has(id); n++) { id = `${base}-${n}`; } used.add(id); return id; };
  const renderer = new Marked.Renderer();
  renderer.html = ({ text }) => esc(text);
  renderer.heading = function ({ tokens, depth, text }) {
    const id = uniqueId(text);
    if (depth === 2) { toc.push(`<li><a href="#${id}">${esc(text)}</a></li>`); }
    return `<h${depth + 1} id="${id}">${this.parser.parseInline(tokens)}</h${depth + 1}>\n`;
  };
  renderer.link = function ({ href, tokens }) {
    const to = href === 'install.md' ? '#install-guide' : href === 'using.md' ? '#first-steps' : href;
    const outside = /^https?:/.test(to) ? ' rel="noopener"' : '';
    return `<a href="${esc(to)}"${outside}>${this.parser.parseInline(tokens)}</a>`;
  };
  const render = (file) => {
    const md = readFileSync(join(repo, 'docs', file), 'utf8').replace(/^# (.*)\r?\n/, (all, title) => `<!--title-->${title}\n`);
    const title = /<!--title-->(.*)/.exec(md)?.[1] ?? '';
    const body = new Marked.Marked({ renderer, gfm: true }).parse(md.replace(/<!--title-->.*\r?\n/, ''));
    // wide tables scroll sideways inside their own box instead of squeezing their columns
    const tables = body.replace(/<table>/g, '<div class="table-wrap" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>');
    return `<h1>${esc(title)}</h1>\n${tables}`;
  };
  const install = render('install.md');
  const installToc = toc.splice(0);
  const using = render('using.md');
  const tocHtml = `<p><b>Installing</b></p><ul>${installToc.join('')}</ul><p><b>First steps</b></p><ul>${toc.join('')}</ul>`;
  return { 'guide-install': install, 'guide-using': using, 'guide-toc': tocHtml };
})();

const parts = (() => {
  const c = comparison();
  const m = marketplace();
  return {
    matrix: c.matrix, chips: c.chips, only: c.only, sources: sources(c.columns),
    'market-grid': m?.grid, 'market-chips': m?.chips, 'market-featured': m?.featured, 'market-json': m?.json,
    ...guide,
    _summary: [c.summary, m?.summary].filter(Boolean).join('; '),
  };
})();

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
let files = 0;
for (const file of walk(src)) {
  const rel = relative(src, file);
  if (/(^|[\\/])_|\.v1\.html$/.test(rel)) { continue; } // drafts and partials stay out
  const out = join(dist, rel);
  mkdirSync(dirname(out), { recursive: true });
  const ext = extname(file).toLowerCase();
  if (!TEXT.has(ext)) { cpSync(file, out); files++; continue; }
  let text = fill(readFileSync(file, 'utf8'), ext === '.html' || ext === '.svg' || ext === '.xml');
  if (ext === '.html') {
    text = text.replace(/<!-- build:([\w-]+) -->/g, (all, name) => {
      const v = parts[name];
      if (v === undefined) { throw new Error(`${rel}: no content for ${all}`); }
      return v;
    });
  }
  writeFileSync(out, text);
  files++;
}
console.log(`site/dist: ${files} files, name "${config.name}"; ${parts._summary}`);
