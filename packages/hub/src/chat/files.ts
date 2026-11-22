/**
 * Files attached to a message, as the model reads them (iteration 2: a receipt photo, insurance quotes, a school PDF
 * and a bank statement reached the model as a name and a hash, and it spent its turn searching for them). When a message
 * is sent each file is kept as a hub resource (`StoreTurnService`, `ChatDeps.files`), so its `<file>` block names the
 * resource's `uri` and the one fn that reads it (`read`): `hub/resource_send` shows a picture itself (the chat models
 * take images), `hub/resource_read` reads anything else as text (a PDF's pages, a spreadsheet's tables). A small
 * text file's text is in the block itself. Those readers join the turn's tools.
 */
import { QualifiedName, type MessagePart } from '@harness/core';
import type { ResourceLibrary, ResourceReader } from '../resources/index.ts';
import type { AttachedFiles } from './deps.ts';
import { escapeAttribute, escapeBody } from './support.ts';

type FilePart = Extract<MessagePart, { type: 'file' }>;

/** The hub fn that reads an attached file in one call: `hub/resource_send` shows a picture itself, `hub/resource_read` reads the rest. */
export function fileReader(mime: string): QualifiedName {
  return QualifiedName.parse(mime.startsWith('image/') ? 'hub/resource_send' : 'hub/resource_read');
}

/** The fns a message's kept files are read with (and `hub/resource_outline` for a long one), so they are in the turn's tools. */
export function fileReaders(parts: readonly MessagePart[]): QualifiedName[] {
  const kept = parts.flatMap((part) => (part.type === 'file' && part.uri !== undefined ? [part] : []));
  if (kept.length === 0) return [];
  return [...new Set([...kept.map((part) => fileReader(part.ref.mime)), QualifiedName.parse('hub/resource_read'), QualifiedName.parse('hub/resource_outline')])];
}

/**
 * A file as the model reads it: `<file name mime size uri read />`, the reader called with `{ "uri": … }`; a small text
 * file with its text inside (`truncated` when only its start is there). A file the hub could not keep has only its
 * content ref (`hash`), which `hub/resource_import` takes.
 */
export function fileTag(part: FilePart): string {
  const base = `name="${escapeAttribute(part.name)}" mime="${escapeAttribute(part.ref.mime)}" size="${part.ref.size}"`;
  if (part.uri === undefined) return `<file ${base} hash="${part.ref.hash}" />`;
  const head = `<file ${base} uri="${escapeAttribute(part.uri)}" read="${fileReader(part.ref.mime)}"${part.truncated === true ? ' truncated="true"' : ''}`;
  return part.text === undefined ? `${head} />` : `${head}>${escapeBody(part.text)}</file>`;
}

/** Whether a file is text the model can read in the message (plain text, markdown, CSV, JSON, XML, code). */
export function isTextFile(mime: string, name: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (/^application\/(json|xml|csv|x-yaml|yaml|toml|x-ndjson)\b/.test(mime)) return true;
  return mime === 'application/octet-stream' && /\.(txt|md|csv|tsv|json|ya?ml|toml|xml|log)$/i.test(name);
}

/** What `resourceFiles` uses of the resources module. */
export interface FileResources {
  readonly library: Pick<ResourceLibrary, 'import'>;
  readonly reader: Pick<ResourceReader, 'read'>;
}

/**
 * `ChatDeps.files` on the resources module: a file is imported as a hub upload (`hub://resources/uploads/<day>/<name>`)
 * as its sender, and a text file's raw text read back, up to `maxChars`.
 */
export function resourceFiles(resources: () => FileResources): AttachedFiles {
  return {
    async keep(file, who, maxChars) {
      const asking = { actor: who.actor, session: who.session };
      const record = await resources().library.import({ content: file.ref, name: file.name }, asking);
      if (maxChars === 0 || !isTextFile(file.ref.mime, file.name)) return { uri: record.uri };
      const read = await resources().reader.read({ uri: record.uri, form: 'raw', maxChars }, asking);
      return { uri: record.uri, text: read.text, ...(read.truncated ? { truncated: true } : {}) };
    },
  };
}
