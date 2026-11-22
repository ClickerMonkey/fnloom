/**
 * The guide's links, made to work once it is split into context items. In the single file a type is linked by its
 * anchor (`[ConfigComponentDecl](#core-configcomponentdecl)`) and a section is named in bold (`**Testing**`). In the
 * context folder the anchor may live in another item, and a bold name is no link at all, so a model reading through
 * `hub/ctx_load` could follow neither. Here an anchor in another item becomes a `context:` link to that item (with
 * the anchor), and a bold section title becomes a `context:` link to its part. Fenced code is left alone.
 */

/** An explicit anchor in the guide: `<a id="x"></a>`. */
const ANCHOR = /<a id="([^"]+)"><\/a>/g;
/** An in-page anchor link. */
const PAGE_ANCHOR = /\]\(#([^)\s]+)\)/g;
/** A bold run of words on one line. */
const BOLD = /\*\*([^*\n]+)\*\*/g;
/** A fence line of a fenced code block. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** One item's body, by its qualified context key. */
export interface ItemBody {
  readonly key: string;
  readonly body: string;
}

/** A part a bold title may name: its qualified key and its title. */
export interface SectionTitle {
  readonly key: string;
  readonly title: string;
}

/** Apply `change` to each line of `text` outside fenced code blocks. */
function outsideFences(text: string, change: (line: string) => string): string {
  let fence: string | undefined;
  return text.split('\n').map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) { fence = marker; } else if (marker[0] === fence[0] && marker.length >= fence.length) { fence = undefined; }
      return line;
    }
    return fence === undefined ? change(line) : line;
  }).join('\n');
}

/** Which item each anchor is in, over every item's body. */
export function anchorHomes(items: readonly ItemBody[]): Map<string, string> {
  const homes = new Map<string, string>();
  for (const item of items) {
    for (const match of item.body.matchAll(ANCHOR)) {
      if (match[1] !== undefined && !homes.has(match[1])) { homes.set(match[1], item.key); }
    }
  }
  return homes;
}

/**
 * The titles a bold name may be: each part's full title, and the words before its colon (`The server` for "The server:
 * serve and the implementation"), lower case. A short form two parts share is left out.
 */
export function sectionTitles(sections: readonly SectionTitle[]): Map<string, string> {
  const titles = new Map<string, string>();
  const shared = new Set<string>();
  for (const section of sections) {
    const short = section.title.split(':')[0]?.trim();
    for (const name of new Set([section.title, ...(short === undefined || short === '' ? [] : [short])])) {
      const lower = name.toLowerCase();
      const known = titles.get(lower);
      if (known !== undefined && known !== section.key) { shared.add(lower); }
      titles.set(lower, section.key);
    }
  }
  for (const name of shared) { titles.delete(name); }
  return titles;
}

/** An item's body with anchors in other items as `context:` links and bold section titles as links to their parts. */
export function linkItem(item: ItemBody, homes: ReadonlyMap<string, string>, titles: ReadonlyMap<string, string>): string {
  return outsideFences(item.body, (line) => line
    .replace(PAGE_ANCHOR, (whole, anchor: string) => {
      const home = homes.get(anchor);
      return home === undefined || home === item.key ? whole : `](context:${home}#${anchor})`;
    })
    .replace(BOLD, (whole, words: string) => {
      const key = titles.get(words.trim().toLowerCase());
      return key === undefined || key === item.key ? whole : `[${words}](context:${key})`;
    }));
}
