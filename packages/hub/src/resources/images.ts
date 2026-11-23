/**
 * Images for a model that can't see them (Phil, 2026-11-23: "if the current model doesn't have vision then the image
 * content should be replaced with xml about the image with an identifier then an image read tool with that ID and a
 * request which does get sent off to an llm configured by an admin to answer the question for the blind llm").
 *
 * In place of the picture such a model reads an `<image>` block: its id (the image's resource uri), its name, type,
 * size and, when the bytes say, its width and height, where it came from, and one line on how to ask about it with
 * `hub/image_read`, which sends the image and the question to the `describe` role's vision model. With no such model
 * set up, the line says so instead.
 */
import { reject } from '@ayepi/core';
import type { ResourceUri } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { Asking, FormModels, FormService, ImageAnswer, ImageQuestions } from './index.ts';

/** Text made safe for an XML attribute. */
function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
}

/** The fn a model that can't see asks about an image with. */
export const IMAGE_READ_FN = 'hub/image_read';

/** How many leading bytes are read to find an image's width and height. */
export const IMAGE_HEAD_BYTES = 64 * 1024;

/** An image's width and height in pixels. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** What an `<image>` block says about one image. */
export interface ImageFacts {
  /** The id `hub/image_read` takes: the image's resource uri. */
  readonly id: string;
  readonly name: string;
  readonly mime?: string | undefined;
  readonly size?: number | undefined;
  readonly dimensions?: ImageSize | undefined;
  /** Where it came from, in plain words ("attached to a message", "shown by hub/resource_send"). */
  readonly source?: string | undefined;
  /** Whether a vision model is set up to answer questions about it. */
  readonly answerable: boolean;
  /** Why it stands in for the picture when that isn't that the model can't see (the picture is too large to send). */
  readonly reason?: string | undefined;
}

/**
 * An image as a model that can't see it reads it. The note is the same for every image, so a model learns it once:
 * the id, the fn and the shape of its call.
 */
export function imageBlock(facts: ImageFacts): string {
  const attrs = [
    `id="${escapeAttribute(facts.id)}"`, `name="${escapeAttribute(facts.name)}"`,
    ...(facts.mime === undefined ? [] : [`mime="${escapeAttribute(facts.mime)}"`]),
    ...(facts.size === undefined ? [] : [`size="${facts.size}"`]),
    ...(facts.dimensions === undefined ? [] : [`width="${facts.dimensions.width}"`, `height="${facts.dimensions.height}"`]),
    ...(facts.source === undefined ? [] : [`source="${escapeAttribute(facts.source)}"`]),
  ];
  const why = facts.reason ?? 'You can\'t see images here, so this image is described by this block instead of shown.';
  const how = facts.answerable
    ? `To learn what it shows, call ${IMAGE_READ_FN} with {"image": ${JSON.stringify(facts.id)}, "question": "<what you need to know>"}: a model that can see images looks at it and answers.`
    : 'No model that can see images is set up, so what it shows can\'t be read here: if it matters, tell the person (an admin can set one up under Models).';
  return `<image ${attrs.join(' ')}>\n${why} ${how}\n</image>`;
}

/** A 32-bit big-endian number. */
function be32(b: Uint8Array, at: number): number {
  return (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
}

/** A 16-bit number, big- or little-endian. */
function u16(b: Uint8Array, at: number, little = false): number {
  return little ? (b[at] ?? 0) + ((b[at + 1] ?? 0) << 8) : ((b[at] ?? 0) << 8) + (b[at + 1] ?? 0);
}

/** A 24-bit little-endian number. */
function le24(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) + ((b[at + 1] ?? 0) << 8) + ((b[at + 2] ?? 0) << 16);
}

/** A size only when both sides are real. */
function sized(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * An image's width and height from its first bytes (PNG, GIF, JPEG and WebP; the first `IMAGE_HEAD_BYTES` are
 * enough for nearly every JPEG), or undefined when the bytes don't say.
 */
export function imageSize(b: Uint8Array): ImageSize | undefined {
  // PNG: the IHDR chunk follows the 8-byte signature
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return sized(be32(b, 16), be32(b, 20));
  // GIF: logical screen width and height, little-endian
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return sized(u16(b, 6, true), u16(b, 8, true));
  // WebP: RIFF....WEBP, then a VP8, VP8L or VP8X chunk
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
    if (chunk === 'VP8 ') return sized(u16(b, 26, true) & 0x3fff, u16(b, 28, true) & 0x3fff);
    if (chunk === 'VP8L') {
      const bits = (b[21] ?? 0) + ((b[22] ?? 0) << 8) + ((b[23] ?? 0) << 16) + ((b[24] ?? 0) << 24);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') return sized(le24(b, 24) + 1, le24(b, 27) + 1);
    return undefined;
  }
  // JPEG: walk the segments to the first start-of-frame
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return undefined;
      const marker = b[at + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
      const length = u16(b, at + 2);
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return sized(u16(b, at + 7), u16(b, at + 5));
      at += 2 + length;
    }
  }
  return undefined;
}

/** What answering questions about images needs. */
export interface ImageQuestionsOptions {
  readonly forms: Pick<FormService, 'snapshot'>;
  readonly content: Pick<ContentStore, 'read'>;
  readonly models: Pick<FormModels, 'ask'>;
}

/** Questions about images over the forms service and the `describe` role's vision model. */
export class HubImageQuestions implements ImageQuestions {
  readonly #o: ImageQuestionsOptions;

  constructor(options: ImageQuestionsOptions) {
    this.#o = options;
  }

  async ask(uri: ResourceUri, question: string, who: Asking, signal?: AbortSignal): Promise<ImageAnswer> {
    const record = await this.#o.forms.snapshot(uri, who);
    if (!record.raw.mime.startsWith('image/')) {
      throw reject(422, 'NOT_AN_IMAGE', `${uri} is ${record.raw.mime}, not an image: read it with hub/resource_read instead`);
    }
    const bytes = await this.#o.content.read(record.raw, 0, record.raw.size);
    const made = await this.#o.models.ask(question, { raw: record.raw, bytes, name: record.stat.name }, who, signal);
    return { image: { id: record.uri, name: record.stat.name }, answer: made.text, model: made.model };
  }
}
