/**
 * Inline markdown: code spans, emphasis (`*`, `_`), strong (`**`, `__`), strikethrough (`~~`), links, images,
 * autolinks (`<https://…>` and bare `https://…`), backslash escapes and hard line breaks. A delimiter that never
 * closes stays literal text, so half-streamed text renders as typed.
 */
import type { MdInline } from './ast.ts';

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const SAFE_LINK = /^(https?:|mailto:|\/(?!\/)|#|\.{1,2}\/)/i;
const SAFE_IMAGE = /^(https?:|\/(?!\/)|\.{1,2}\/)/i;
const BARE_URL = /^https?:\/\/[^\s<>"]+/;
const TRAILING = /[.,;:!?)\]'"]+$/;

/** The URL if links may go there, else `undefined`. Refuses `javascript:`, `data:` and protocol-relative URLs. */
export function safeLink(href: string): string | undefined {
  const trimmed = href.trim();
  return SAFE_LINK.test(trimmed) ? trimmed : undefined;
}

/** The URL if an image may load from it, else `undefined`. */
export function safeImage(src: string): string | undefined {
  const trimmed = src.trim();
  return SAFE_IMAGE.test(trimmed) ? trimmed : undefined;
}

/** Find the `]` that closes the `[` at `open`, honouring nesting and escapes. */
function closeBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') { depth++; }
    if (ch === ']') { depth--; if (depth === 0) { return i; } }
  }
  return -1;
}

/** Read `(url "title")` at `open`; returns the url and where it ends. */
function readDestination(text: string, open: number): { url: string; end: number } | undefined {
  if (text[open] !== '(') { return undefined; }
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') { depth++; }
    if (ch === ')') {
      depth--;
      if (depth === 0) {
        const inner = text.slice(open + 1, i).trim();
        const url = inner.replace(/\s+("[^"]*"|'[^']*')$/, '').replace(/^<(.*)>$/, '$1');
        return { url, end: i + 1 };
      }
    }
  }
  return undefined;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Find a closing delimiter run for an opener at `from`; `_` must not be inside a word. */
function closeDelimiter(text: string, from: number, delimiter: string): number {
  for (let i = from; i <= text.length - delimiter.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`';
      const end = text.indexOf(run, i + run.length);
      if (end >= 0) { i = end + run.length - 1; continue; }
    }
    if (delimiter.length === 1 && ch === delimiter) {
      // a single `*` never closes on part of a longer run such as `**`; skip the whole run
      let run = 1;
      while (text[i + run] === delimiter) { run++; }
      if (run > 1) { i += run - 1; continue; }
    }
    if (text.startsWith(delimiter, i) && i > from && !/\s/.test(text[i - 1] ?? ' ')) {
      if (delimiter.startsWith('_') && isWordChar(text[i + delimiter.length])) { continue; }
      return i;
    }
  }
  return -1;
}

/** Merge neighbouring text nodes. */
function pushText(out: MdInline[], text: string): void {
  if (text === '') { return; }
  const last = out.at(-1);
  if (last?.type === 'text') { out[out.length - 1] = { type: 'text', text: last.text + text }; } else { out.push({ type: 'text', text }); }
}

const EMPHASIS = [
  { delimiter: '**', type: 'strong' },
  { delimiter: '__', type: 'strong' },
  { delimiter: '~~', type: 'del' },
  { delimiter: '*', type: 'em' },
  { delimiter: '_', type: 'em' },
] as const;

/** Parse a block's inline text. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const rest = text.slice(i);

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') { out.push({ type: 'break' }); i += 2; continue; }
      if (next !== undefined && PUNCTUATION.test(next)) { pushText(out, next); i += 2; continue; }
    }

    if (ch === '\n') {
      if (out.at(-1)?.type === 'text') {
        const last = out.at(-1);
        if (last?.type === 'text' && / {2,}$/.test(last.text)) {
          out[out.length - 1] = { type: 'text', text: last.text.replace(/ +$/, '') };
          out.push({ type: 'break' });
          i++;
          continue;
        }
      }
      pushText(out, '\n');
      i++;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`';
      const end = text.indexOf(run, i + run.length);
      if (end >= 0) {
        const inner = text.slice(i + run.length, end).replace(/\n/g, ' ');
        const trimmed = inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner;
        out.push({ type: 'code', text: trimmed });
        i = end + run.length;
        continue;
      }
      pushText(out, run);
      i += run.length;
      continue;
    }

    if (ch === '!' && text[i + 1] === '[') {
      const close = closeBracket(text, i + 1);
      const dest = close >= 0 ? readDestination(text, close + 1) : undefined;
      if (dest) {
        const alt = text.slice(i + 2, close);
        const src = safeImage(dest.url);
        if (src === undefined) { pushText(out, alt); } else { out.push({ type: 'image', src, alt }); }
        i = dest.end;
        continue;
      }
    }

    if (ch === '[') {
      const close = closeBracket(text, i);
      const dest = close >= 0 ? readDestination(text, close + 1) : undefined;
      if (dest) {
        const children = parseInline(text.slice(i + 1, close));
        const href = safeLink(dest.url);
        if (href === undefined) { for (const child of children) { if (child.type === 'text') { pushText(out, child.text); } else { out.push(child); } } } else { out.push({ type: 'link', href, children }); }
        i = dest.end;
        continue;
      }
    }

    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (auto?.[1] !== undefined) {
        out.push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1].replace(/^mailto:/i, '') }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && !isWordChar(text[i - 1])) {
      const bare = BARE_URL.exec(rest)?.[0];
      if (bare !== undefined) {
        const url = bare.replace(TRAILING, '');
        out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    const emphasis = EMPHASIS.find((e) => rest.startsWith(e.delimiter));
    if (emphasis && !/\s/.test(text[i + emphasis.delimiter.length] ?? ' ') && !(emphasis.delimiter.startsWith('_') && isWordChar(text[i - 1]))) {
      const start = i + emphasis.delimiter.length;
      const end = closeDelimiter(text, start, emphasis.delimiter);
      if (end > start) {
        out.push({ type: emphasis.type, children: parseInline(text.slice(start, end)) });
        i = end + emphasis.delimiter.length;
        continue;
      }
    }

    const plain = /^[^\\\n`![<*_~hH]+/.exec(rest)?.[0];
    if (plain !== undefined) { pushText(out, plain); i += plain.length; continue; }
    pushText(out, ch);
    i++;
  }
  return out;
}
