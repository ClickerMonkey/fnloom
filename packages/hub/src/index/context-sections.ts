/**
 * A context item's sections: its indexed text (`contextText`) cut at its markdown headings by `@aeye/resources`
 * (`splitMarkdownSections`, fenced code skipped), each keyed by its heading path through the SDK's `sectionKeys`, as
 * resources are (`hub/headings`). Each heading section is indexed as its own `contextSection` item under its context
 * (`IndexEntry.parent`), so search finds content past the item's own indexed text (`HARNESS_INDEX_MAX_TEXT`) and a hit
 * says which section matched. The text before the first heading is the item's own; an item with no headings has no
 * sections, its whole text being the item.
 */
import { splitMarkdownSections } from '@aeye/resources';
import type { SectionKey } from '@harness/core';
import { sectionKeys } from '@harness/sdk';
import type { IndexItem } from './index.ts';

/** One heading section of a context item: its key, its heading path and title, and where it is in the text. */
export interface ContextSection {
  readonly key: SectionKey;
  readonly path: readonly string[];
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

/** The heading sections of a context item's indexed text, in order. */
export function contextSections(text: string): ContextSection[] {
  const cut = splitMarkdownSections(text).filter((section) => section.headings.length > 0);
  const keys = sectionKeys(cut.map((section) => section.headings));
  return cut.flatMap((section, i) => {
    const key = keys[i];
    return key === undefined ? [] : [{ key, path: section.headings, title: section.headings.at(-1) ?? '', start: section.start, end: section.end }];
  });
}

/** The index key of a context item's section. */
export function contextSectionKey(name: string, key: string): string {
  return `${name}#${key}`;
}

/** A context section's key within its item, from its index key and the item's name (`SearchHit.parent`). */
export function sectionKeyOf(indexKey: string, parent: string): string | undefined {
  return indexKey.startsWith(`${parent}#`) ? indexKey.slice(parent.length + 1) : undefined;
}

/** A context item's sections as index items, each under the item (`parent`), titled by its heading path. */
export function contextSectionItems(item: IndexItem): IndexItem[] {
  if (item.kind !== 'context') return [];
  return contextSections(item.text).map((section) => ({
    kind: 'contextSection', key: contextSectionKey(item.key, section.key), parent: item.key,
    text: `${item.key} > ${section.path.join(' > ')}\n\n${item.text.slice(section.start, section.end)}`,
    ...(item.system === undefined ? {} : { system: item.system }),
  }));
}
