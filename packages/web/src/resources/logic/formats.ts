/**
 * What the web knows about resource formats beyond their family: the icon of each family, the words for families
 * and forms, and the language a format's text is highlighted as. The family itself (`familyOf`, `FORMAT_FAMILY`)
 * comes from core, the one table the hub's facets read too. Pure, so it is tested alone.
 */
import { familyOf, type FormatFamily, type FormKind, type ResourceStat } from '@harness/core';
import type { IconName } from '../../ui/index.ts';

/** The icon of each family. */
export const FAMILY_ICON = {
  document: 'book-open', code: 'code', image: 'image', table: 'table', audio: 'music', video: 'video', web: 'globe', data: 'braces', archive: 'archive', folder: 'folder', other: 'file',
} as const satisfies Record<FormatFamily, IconName>;

/** The words for each family, as a group heading. */
export const FAMILY_LABEL = {
  document: 'Documents', code: 'Code', image: 'Images', table: 'Tables', audio: 'Audio', video: 'Video', web: 'Web pages', data: 'Data', archive: 'Archives', folder: 'Folders', other: 'Other',
} as const satisfies Record<FormatFamily, string>;

/** The words for each form, as a mode tab and a badge. */
export const FORM_LABEL = {
  markdown: 'Markdown', text: 'Text', code: 'Formatted', pages: 'Pages', table: 'Table', description: 'Description', ocr: 'Text in image', transcript: 'Transcript', thumbnail: 'Thumbnail',
} as const satisfies Record<FormKind, string>;

/** The forms shown as badges in the browser (a thumbnail is shown, not named). */
export const BADGE_FORMS = ['markdown', 'table', 'pages', 'description', 'ocr', 'transcript'] as const satisfies readonly FormKind[];

/**
 * The highlighter's language for each format whose text is code or data. Formats from `@aeye/resources`' type
 * names (`typescript`, `shell`, `csharp`) map to the names highlighters use.
 */
const LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'ts', javascript: 'js', jsx: 'jsx', tsx: 'tsx', vue: 'vue', python: 'python', ruby: 'ruby', go: 'go', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs',
  php: 'php', rust: 'rust', swift: 'swift', kotlin: 'kotlin', scala: 'scala', sql: 'sql', shell: 'sh', css: 'css', scss: 'scss', less: 'less', dockerfile: 'dockerfile',
  graphql: 'graphql', lua: 'lua', r: 'r', dart: 'dart', json: 'json', jsonl: 'json', yaml: 'yaml', toml: 'toml', xml: 'xml', ini: 'ini', html: 'html', svg: 'xml',
  markdown: 'markdown', mermaid: 'mermaid', csv: 'csv', tsv: 'tsv', text: 'text',
};

/** The language a format's text is highlighted as ('' when it isn't code). */
export function languageOf(format: string | undefined): string {
  return format === undefined ? '' : LANGUAGE[format] ?? '';
}

/** Whether a format's text is code the highlighter can colour, though core's families don't list it (`ruby`, `dart`). */
export function isCodeFormat(format: string | undefined): boolean {
  const language = languageOf(format);
  return language !== '' && !['markdown', 'mermaid', 'csv', 'tsv', 'text', 'html', 'xml', 'json', 'yaml', 'toml', 'ini'].includes(language);
}

/** The family of a resource, from its format and mime type, with code formats core doesn't list as code. */
export function familyOfStat(stat: Pick<ResourceStat, 'format' | 'mime' | 'type'>): FormatFamily {
  if (stat.type === 'folder') { return 'folder'; }
  const family = familyOf(stat.format, stat.mime);
  return family === 'other' && isCodeFormat(stat.format) ? 'code' : family;
}

/** The extension of a resource's name (`ts`, `tar.gz` reads as `gz`), lower case; '' when it has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}
