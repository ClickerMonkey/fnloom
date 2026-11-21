/**
 * Inline markdown: code spans, emphasis (`*`, `_`), strong (`**`, `__`), strikethrough (`~~`), links, images,
 * autolinks (`<https://…>`, bare `https://…` and bare `file:///…`), backslash escapes and hard line breaks. A delimiter that never
 * closes stays literal text, so half-streamed text renders as typed.
 */
import { isHttpUrl } from '@harness/core';
import { APP_PATH, safeHref } from '@harness/sdk';
import type { MdInline } from './ast.ts';

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const BARE_URL = /^https?:\/\/[^\s<>"]+/;
/** A bare `file:///…` URI in text, linked like a web address so a file the agent names opens in the viewer. */
const BARE_FILE = /^file:\/\/\/[^\s<>"`]+/i;
const TRAILING = /[.,;:!?)\]'"]+$/;

/** The URL if an image may load from it (a link `safeHref` allows that is http, https or a place in the app), else `undefined`. */
export function safeImage(src: string): string | undefined {
  const href = safeHref(src);
  return href !== undefined && (isHttpUrl(href) || APP_PATH.test(href)) ? href : undefined;
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

/**
 * Inline math at `open` (a `$`): the TeX up to the closing `$` and where it ends, or undefined when this `$` isn't
 * math. Like pandoc: the opener is followed by something other than a space, the closer is preceded by something
 * other than a space and not followed by a digit, so prices ("$5 and $10") stay text.
 */
function inlineMath(text: string, open: number): { tex: string; end: number } | undefined {
  const first = text[open + 1];
  if (first === undefined || /\s|\$/.test(first)) { return undefined; }
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '\n' && text[i + 1] === '\n') { return undefined; }
    if (ch === '$') {
      if (/\s/.test(text[i - 1] ?? ' ') || /\d/.test(text[i + 1] ?? '')) { return undefined; }
      return { tex: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return undefined;
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
        const href = safeHref(dest.url);
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

    if ((ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') && !isWordChar(text[i - 1])) {
      const bare = (BARE_URL.exec(rest) ?? BARE_FILE.exec(rest))?.[0];
      if (bare !== undefined) {
        const url = bare.replace(TRAILING, '');
        out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    if (ch === '$') {
      const math = inlineMath(text, i);
      if (math !== undefined) { out.push({ type: 'math', tex: math.tex }); i = math.end; continue; }
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

    const plain = /^[^\\\n`![<*_~hHfF$]+/.exec(rest)?.[0];
    if (plain !== undefined) { pushText(out, plain); i += plain.length; continue; }
    pushText(out, ch);
    i++;
  }
  return out;
}
