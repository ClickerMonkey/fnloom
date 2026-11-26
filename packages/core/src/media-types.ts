/**
 * What kind of content bytes are: from the bytes themselves first (the magic numbers of the images, documents, audio
 * and video the hub handles), from the name's extension second (any case: `IMG_2890.JPG` is a JPEG). A file's name can
 * lie or be missing, its bytes can't, so a picture named `.txt` is still a picture and a text file named `.jpg` is not.
 * Also what a provider takes as an image part: a data URL of a picture type whose bytes really are that picture.
 */

/** How many leading bytes `sniffMime` looks at (a zip's office part names sit near its start). */
export const SNIFF_HEAD = 64 * 1024;

/** The media type of text that has no more specific one. */
export const PLAIN_TEXT_MIME = 'text/plain; charset=utf-8';
/** The media type of bytes nothing more is known about. */
export const UNKNOWN_MIME = 'application/octet-stream';

/** Media types by file extension (lower case, with its dot). */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
  '.avif': 'image/avif', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * The media type bytes are in, told by their first bytes: png, jpeg, gif, webp, bmp, tiff, heic/avif, pdf, zip (a word
 * document or a workbook told apart by its part names), mp3, wav, ogg, flac, m4a/mp4/mov and webm/mkv. `undefined` for
 * anything else, text included.
 */
export function sniffMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) { return 'image/png'; }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) { return 'image/jpeg'; }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) { return 'image/gif'; }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12) {
    const kind = ascii(bytes, 8, 4);
    if (kind === 'WEBP') { return 'image/webp'; }
    if (kind === 'WAVE') { return 'audio/wav'; }
    if (kind === 'AVI ') { return 'video/x-msvideo'; }
  }
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length > 14 && bytes[6] === 0 && bytes[7] === 0) { return 'image/bmp'; }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) { return 'image/tiff'; }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) { return 'application/pdf'; }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    const head = ascii(bytes, 0, Math.min(bytes.length, SNIFF_HEAD));
    if (head.includes('word/')) { return BY_EXTENSION['.docx']; }
    if (head.includes('xl/')) { return BY_EXTENSION['.xlsx']; }
    return 'application/zip';
  }
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 0x06) !== 0)) { return 'audio/mpeg'; }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) { return 'audio/ogg'; }
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) { return 'audio/flac'; }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') { return 'image/heic'; }
    if (brand === 'avif' || brand === 'avis') { return 'image/avif'; }
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) { return 'audio/mp4'; }
    if (brand === 'qt  ') { return 'video/quicktime'; }
    return 'video/mp4';
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) { return ascii(bytes, 0, Math.min(bytes.length, 64)).includes('webm') ? 'video/webm' : 'video/x-matroska'; }
  return undefined;
}

/** The media type a name's extension says, in any case (`IMG_2890.JPG`), or `undefined` for an unknown one. */
export function mimeOfName(name: string): string | undefined {
  const base = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? undefined : BY_EXTENSION[base.slice(dot)];
}

/**
 * The media type of content: what its bytes say, else what its name says, else plain text when the bytes read as
 * text, else unknown. A name that says text never wins over bytes that are a picture, and a name that says picture
 * never wins over bytes that are not one: a known binary type from the name only counts when the bytes don't look
 * like text.
 */
export function detectMime(bytes: Uint8Array, name?: string): string {
  const sniffed = sniffMime(bytes);
  if (sniffed !== undefined) { return sniffed; }
  const named = name === undefined ? undefined : mimeOfName(name);
  const text = looksLikeText(bytes);
  if (named !== undefined && (named.startsWith('text/') || named === 'application/json' || named === 'application/xml' || named === 'image/svg+xml')) { return text ? named : UNKNOWN_MIME; }
  if (named !== undefined && !text) { return named; }
  return text ? PLAIN_TEXT_MIME : UNKNOWN_MIME;
}

/** Whether bytes read as text: no NUL byte near the start, and valid UTF-8 (a character cut at the end of the look still counts). Empty bytes are text. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8_000).includes(0)) { return false; }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, SNIFF_HEAD), { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** The picture types a chat provider takes as an image part. */
export const IMAGE_PART_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Why an image part's content can't go to a provider as a picture, or `undefined` when it can: an `http(s)` URL, or a
 * base64 data URL of a picture type (`IMAGE_PART_MIMES`) whose bytes really are that kind of picture.
 */
export function imagePartProblem(content: string): string | undefined {
  if (/^https?:\/\//i.test(content)) { return undefined; }
  const comma = content.indexOf(',');
  if (!content.startsWith('data:') || comma < 0) { return 'it is not a picture link or picture data'; }
  const [type = '', ...params] = content.slice(5, comma).split(';');
  const declared = type.trim().toLowerCase();
  const says = declared === '' ? 'nothing' : declared;
  if (!params.some((param) => param.trim().toLowerCase() === 'base64')) { return `its data isn't base64 (it says ${says})`; }
  const head = base64Head(content.slice(comma + 1, comma + 1 + 4096));
  if (head.length === 0) { return `it is empty (it says ${says})`; }
  const actual = sniffMime(head);
  if (actual === undefined || !actual.startsWith('image/')) { return `its bytes are not a picture (it says ${says})`; }
  if (!IMAGE_PART_MIMES.includes(actual)) { return `it is ${actual}, a kind of picture the model can't be sent`; }
  if (declared !== actual) { return `it says ${says} but its bytes are ${actual}`; }
  return undefined;
}

/** The bytes of the start of base64 text (whole groups of four only), without Node's Buffer so browsers can use it too. */
function base64Head(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/_-]/g, '');
  const usable = clean.slice(0, clean.length - (clean.length % 4));
  try {
    const binary = atob(usable.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}
