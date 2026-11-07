import { describe, expect, it } from 'vitest';
import type { MdBlock } from './ast.ts';
import { parseInline, safeImage, safeLink } from './inline.ts';
import { parseMarkdown } from './parse.ts';

const text = (t: string) => ({ type: 'text', text: t }) as const;

describe('parseInline', () => {
  it('reads emphasis, strong, strikethrough and code', () => {
    expect(parseInline('a *b* __c__ ~~d~~ `e`')).toEqual([
      text('a '), { type: 'em', children: [text('b')] }, text(' '), { type: 'strong', children: [text('c')] }, text(' '),
      { type: 'del', children: [text('d')] }, text(' '), { type: 'code', text: 'e' },
    ]);
  });

  it('nests emphasis inside strong, and strong inside emphasis', () => {
    expect(parseInline('**a *b* c**')).toEqual([{ type: 'strong', children: [text('a '), { type: 'em', children: [text('b')] }, text(' c')] }]);
    expect(parseInline('*a **b** c*')).toEqual([{ type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] }]);
  });

  it('leaves unclosed delimiters as typed (streaming text)', () => {
    expect(parseInline('**half')).toEqual([text('**half')]);
    expect(parseInline('a * b')).toEqual([text('a * b')]);
    expect(parseInline('`open')).toEqual([text('`open')]);
  });

  it('does not treat underscores inside words as emphasis', () => {
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')]);
    expect(parseInline('_yes_')).toEqual([{ type: 'em', children: [text('yes')] }]);
  });

  it('keeps code spans literal, including delimiters and longer backtick runs', () => {
    expect(parseInline('`*not em*`')).toEqual([{ type: 'code', text: '*not em*' }]);
    expect(parseInline('`` a `b` ``')).toEqual([{ type: 'code', text: 'a `b`' }]);
  });

  it('reads links, images and autolinks', () => {
    expect(parseInline('[docs](https://example.com/a "Title")')).toEqual([{ type: 'link', href: 'https://example.com/a', children: [text('docs')] }]);
    expect(parseInline('![logo](/img/logo.png)')).toEqual([{ type: 'image', src: '/img/logo.png', alt: 'logo' }]);
    expect(parseInline('<mailto:a@b.co>')).toEqual([{ type: 'link', href: 'mailto:a@b.co', children: [text('a@b.co')] }]);
    expect(parseInline('see https://example.com/x.')).toEqual([text('see '), { type: 'link', href: 'https://example.com/x', children: [text('https://example.com/x')] }, text('.')]);
    expect(parseInline('[a [nested] b](/x)')).toEqual([{ type: 'link', href: '/x', children: [text('a [nested] b')] }]);
  });

  it('drops unsafe link and image URLs, keeping their text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([text('click')]);
    expect(parseInline('![x](data:image/png;base64,AAAA)')).toEqual([text('x')]);
    expect(safeLink('JavaScript:alert(1)')).toBeUndefined();
    expect(safeLink('//evil.example')).toBeUndefined();
    expect(safeLink('/chat/ses_1')).toBe('/chat/ses_1');
    expect(safeLink('#m-1')).toBe('#m-1');
    expect(safeImage('mailto:a@b.co')).toBeUndefined();
  });

  it('links the resource URIs systems serve, file:/// ones included, bare or in a link', () => {
    const uri = 'file:///C:/work/docs/harness.md';
    expect(safeLink(uri)).toBe(uri);
    expect(safeLink('fs://docs/a.md')).toBe('fs://docs/a.md');
    expect(parseInline(`read ${uri}, then`)).toEqual([text('read '), { type: 'link', href: uri, children: [text(uri)] }, text(', then')]);
    expect(parseInline(`[harness.md](${uri})`)).toEqual([{ type: 'link', href: uri, children: [text('harness.md')] }]);
    expect(parseInline('profile://x')).toEqual([text('profile://x')]);
  });

  it('reads escapes and hard breaks', () => {
    expect(parseInline('\\*not\\*')).toEqual([text('*not*')]);
    expect(parseInline('a  \nb')).toEqual([text('a'), { type: 'break' }, text('b')]);
    expect(parseInline('a\\\nb')).toEqual([text('a'), { type: 'break' }, text('b')]);
    expect(parseInline('a\nb')).toEqual([text('a\nb')]);
  });
});

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and rules', () => {
    expect(parseMarkdown('# Title #\n\nOne\ntwo\n\n---\n### Small')).toEqual<MdBlock[]>([
      { type: 'heading', level: 1, children: [text('Title')] },
      { type: 'paragraph', children: [text('One\ntwo')] },
      { type: 'rule' },
      { type: 'heading', level: 3, children: [text('Small')] },
    ]);
  });

  it('reads fenced code, closed or still open', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n\nconst b = 2;\n```\nafter')).toEqual<MdBlock[]>([
      { type: 'code', lang: 'ts', text: 'const a = 1;\n\nconst b = 2;', open: false },
      { type: 'paragraph', children: [text('after')] },
    ]);
    expect(parseMarkdown('~~~\nstreaming')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'streaming', open: true }]);
    expect(parseMarkdown('````\n```\ninner\n```\n````')[0]).toMatchObject({ text: '```\ninner\n```', open: false });
  });

  it('reads block quotes with lazy lines and nested blocks', () => {
    expect(parseMarkdown('> # Note\n> one\ntwo\n\nout')).toEqual<MdBlock[]>([
      { type: 'quote', children: [{ type: 'heading', level: 1, children: [text('Note')] }, { type: 'paragraph', children: [text('one\ntwo')] }] },
      { type: 'paragraph', children: [text('out')] },
    ]);
  });

  it('reads bullet, numbered, nested and task lists', () => {
    expect(parseMarkdown('- a\n- b\n  - c\n- d')).toEqual<MdBlock[]>([{
      type: 'list', ordered: false, start: 1, items: [
        { checked: undefined, children: [{ type: 'paragraph', children: [text('a')] }] },
        { checked: undefined, children: [{ type: 'paragraph', children: [text('b')] }, { type: 'list', ordered: false, start: 1, items: [{ checked: undefined, children: [{ type: 'paragraph', children: [text('c')] }] }] }] },
        { checked: undefined, children: [{ type: 'paragraph', children: [text('d')] }] },
      ],
    }]);
    expect(parseMarkdown('3. three\n4. four')[0]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(parseMarkdown('- [x] done\n- [ ] todo')[0]).toMatchObject({ items: [{ checked: true }, { checked: false }] });
  });

  it('keeps a list going across a blank line, and ends it at another block', () => {
    const blocks = parseMarkdown('- a\n\n- b\n\nAfter');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'list', items: [{}, {}] });
    expect(parseMarkdown('Text\n- item')).toMatchObject([{ type: 'paragraph' }, { type: 'list' }]);
  });

  it('reads tables with alignment, padding short rows', () => {
    expect(parseMarkdown('| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 |\n| x \\| y | z | w |')).toEqual<MdBlock[]>([{
      type: 'table', align: ['left', 'center', 'right'],
      head: [[text('A')], [text('B')], [text('C')]],
      rows: [[[text('1')], [text('2')], []], [[text('x | y')], [text('z')], [text('w')]]],
    }]);
  });

  it('normalises line endings and tabs', () => {
    expect(parseMarkdown('a\r\nb')).toEqual([{ type: 'paragraph', children: [text('a\nb')] }]);
    expect(parseMarkdown('')).toEqual([]);
  });
});
