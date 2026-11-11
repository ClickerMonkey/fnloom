/**
 * The authoring guide in parts, one per topic, so a model with a small window reads only the parts it needs:
 * `guideParts` cuts the composed guide at its topic headings (with fs's own cutter). `context-files.ts` writes them as
 * fs's context folder.
 */
import { sectionOf } from '../../systems/fs/server/sections.ts';
import { topicHeading, type Topic } from './compose.ts';

/** One part of the guide: its topic, its context name (`authoring-<topic>`), its heading and its text. */
export interface GuidePart {
  readonly topic: Topic;
  readonly name: string;
  readonly heading: string;
  readonly text: string;
}

/** The guide's parts in the outline's order. Throws when a topic's heading isn't in the guide. */
export function guideParts(guide: string, outline: readonly Topic[]): GuidePart[] {
  const headings = outline.map(topicHeading);
  return outline.map((topic, index) => {
    const heading = headings[index] ?? topicHeading(topic, index);
    const text = sectionOf(guide, heading, headings[index + 1]);
    if (text === undefined) { throw new Error(`the guide has no section "${heading}"`); }
    return { topic, name: `authoring-${topic.id}`, heading, text };
  });
}
