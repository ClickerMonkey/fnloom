/**
 * The pictures the index embeds in the image space (`Embedders.images`): image resources, each keyed by its URI, and
 * the images a context item shows: its markdown images (`![alt](src)`), which `@aeye/resources`
 * (`extractLinksFromMarkdown`) marks as image links, kept to http(s) ones, each keyed `<context name>#image:<hash>` under its item
 * (`IndexEntry.parent`) like a context section. An image item's text is a caption (its name, its alt text), which is
 * what words find; its vector is the picture's.
 */
import { extractLinksFromMarkdown, isHttpUrl } from '@aeye/resources';
import { familyOf, type ResourceStat, type SystemName } from '@harness/core';
import { sha256Hex } from '../link/keys.ts';
import type { IndexItem } from './index.ts';

/** Characters of a URL's hash in a context image's key. */
const IMAGE_KEY_HASH = 12;

/** Whether a resource is a picture the image space can embed (an image, not text drawn as one, like mermaid). */
export function isPicture(stat: Pick<ResourceStat, 'format' | 'mime'>): boolean {
  return familyOf(stat.format, stat.mime) === 'image' && stat.format !== 'mermaid' && stat.format !== 'svg';
}

/** An image resource as the item the index embeds: keyed by its URI, its picture its bytes at this version. */
export function resourceImageItem(stat: ResourceStat, system: SystemName, caption?: string): IndexItem {
  return { kind: 'image', key: stat.uri, system, text: caption === undefined || caption === '' ? stat.name : `${stat.name}\n\n${caption}`, image: { source: stat.uri, version: stat.version } };
}

/** The index key of an image a context item shows. */
export function contextImageKey(name: string, url: string): string {
  return `${name}#image:${sha256Hex(url).slice(0, IMAGE_KEY_HASH)}`;
}

/** The images a context item shows (its http(s) markdown images) as index items under the item. A plain link to a picture is a link, not one it shows. */
export function contextImageItems(item: IndexItem): IndexItem[] {
  if (item.kind !== 'context') return [];
  const seen = new Set<string>();
  return extractLinksFromMarkdown(item.text, item.key).flatMap((link): IndexItem[] => {
    if (link.targetType !== 'image' || !isHttpUrl(link.value) || !URL.canParse(link.value) || seen.has(link.value)) return [];
    seen.add(link.value);
    return [{
      kind: 'image', key: contextImageKey(item.key, link.value), parent: item.key, text: `${item.key}: ${link.title ?? link.value.split('/').at(-1) ?? link.value}`,
      image: { source: link.value }, ...(item.system === undefined ? {} : { system: item.system }),
    }];
  });
}
