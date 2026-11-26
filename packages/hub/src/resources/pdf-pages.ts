/**
 * The pictures a pdf's pages are made of: a scanner (or a phone app, or a printer that "prints to pdf" a picture)
 * makes a pdf whose every page is one picture and no text, so its text form is empty and the only way to know what
 * it says is to look at that picture. This reads each page's largest picture straight out of the file, with no
 * renderer: a JPEG as it is, a compressed bitmap (grey, RGB, 1 to 8 bits, with or without PNG row filters, its soft
 * mask laid over white) as a PNG. Pages with no picture, and pictures in kinds this can't read (JPEG 2000, JBIG2,
 * fax, palettes, CMYK bitmaps), have none: the caller says so plainly instead of sending anything.
 *
 * It reads plain objects and object streams, follows the page tree in order (with inherited resources) and looks
 * into form objects one level down, where some writers put a page's picture.
 */
import { deflateSync, inflateSync } from 'node:zlib';

/** One page's picture, ready to send as an image part. */
export interface PageImage {
  /** 1-based. */
  readonly page: number;
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** What a pdf's pages hold as pictures: one entry per page, `undefined` where a page has no picture this can read. */
export interface PdfPictures {
  readonly pages: number;
  readonly images: ReadonlyArray<PageImage | undefined>;
}

/** The largest bitmap made into a PNG, in pixels, so one odd page can't take all the memory. */
const MAX_PIXELS = 40_000_000;

/** A pdf value as far as this reads one: numbers, names, refs, dicts, arrays and strings. */
type Value = number | boolean | null | { readonly name: string } | { readonly ref: number } | { readonly dict: Dict } | { readonly array: Value[] } | { readonly text: string };
type Dict = Map<string, Value>;

/** A parsed object: its dict (or value) and, for a stream, its raw bytes. */
interface PdfObject {
  readonly value: Value;
  readonly stream?: Uint8Array;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** A tokenizer over pdf syntax, enough for dicts, arrays, names, numbers, refs and strings. */
class Lexer {
  at: number;
  readonly #b: Uint8Array;

  constructor(bytes: Uint8Array, at = 0) {
    this.#b = bytes;
    this.at = at;
  }

  #skip(): void {
    const b = this.#b;
    while (this.at < b.length) {
      const c = b[this.at] ?? 0;
      if (WHITESPACE.has(c)) { this.at++; continue; }
      if (c === 0x25) { while (this.at < b.length && b[this.at] !== 0x0a && b[this.at] !== 0x0d) { this.at++; } continue; }
      break;
    }
  }

  #word(): string {
    const b = this.#b;
    const start = this.at;
    while (this.at < b.length && !WHITESPACE.has(b[this.at] ?? 0) && !DELIMITERS.has(b[this.at] ?? 0)) { this.at++; }
    return String.fromCharCode(...b.subarray(start, this.at));
  }

  /** The next keyword or value, or `undefined` at the end. Keywords (`obj`, `stream`, `R`) come back as `{ keyword }`. */
  value(): Value | { keyword: string } | undefined {
    this.#skip();
    const b = this.#b;
    if (this.at >= b.length) { return undefined; }
    const c = b[this.at] ?? 0;
    if (c === 0x2f) { this.at++; return { name: this.#word() }; }
    if (c === 0x5b) {
      this.at++;
      const array: Value[] = [];
      for (;;) {
        this.#skip();
        if (this.at >= b.length) { return { array }; }
        if (b[this.at] === 0x5d) { this.at++; return { array }; }
        const item = this.#item();
        if (item === undefined) { return { array }; }
        array.push(item);
      }
    }
    if (c === 0x3c && b[this.at + 1] === 0x3c) {
      this.at += 2;
      const dict: Dict = new Map();
      for (;;) {
        this.#skip();
        if (this.at >= b.length) { return { dict }; }
        if (b[this.at] === 0x3e && b[this.at + 1] === 0x3e) { this.at += 2; return { dict }; }
        const key = this.value();
        if (key === undefined || typeof key !== 'object' || key === null || !('name' in key)) { return { dict }; }
        const item = this.#item();
        if (item === undefined) { return { dict }; }
        dict.set(key.name, item);
      }
    }
    if (c === 0x3c) {
      const end = b.indexOf(0x3e, this.at);
      this.at = end < 0 ? b.length : end + 1;
      return { text: '' };
    }
    if (c === 0x28) {
      let depth = 0;
      for (; this.at < b.length; this.at++) {
        const ch = b[this.at];
        if (ch === 0x5c) { this.at++; continue; }
        if (ch === 0x28) { depth++; }
        if (ch === 0x29 && --depth === 0) { this.at++; break; }
      }
      return { text: '' };
    }
    if (DELIMITERS.has(c)) { this.at++; return { keyword: String.fromCharCode(c) }; }
    const word = this.#word();
    if (word === '') { this.at++; return { keyword: '' }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { return Number(word); }
    if (word === 'true' || word === 'false') { return word === 'true'; }
    if (word === 'null') { return null; }
    return { keyword: word };
  }

  /** A value, with `n g R` read as a ref. */
  #item(): Value | undefined {
    const first = this.value();
    if (first === undefined || (typeof first === 'object' && first !== null && 'keyword' in first)) { return undefined; }
    if (typeof first !== 'number' || !Number.isInteger(first)) { return first; }
    const back = this.at;
    const second = this.value();
    if (typeof second === 'number' && Number.isInteger(second)) {
      const third = this.value();
      if (typeof third === 'object' && third !== null && 'keyword' in third && third.keyword === 'R') { return { ref: first }; }
    }
    this.at = back;
    return first;
  }

  /** The value at this point (after `n g obj`), with `R` refs. */
  item(): Value | undefined {
    return this.#item();
  }
}

function dictOf(value: Value | undefined): Dict | undefined {
  return typeof value === 'object' && value !== null && 'dict' in value ? value.dict : undefined;
}
function nameOf(value: Value | undefined): string | undefined {
  return typeof value === 'object' && value !== null && 'name' in value ? value.name : undefined;
}
function arrayOf(value: Value | undefined): Value[] | undefined {
  return typeof value === 'object' && value !== null && 'array' in value ? value.array : undefined;
}
function refOf(value: Value | undefined): number | undefined {
  return typeof value === 'object' && value !== null && 'ref' in value ? value.ref : undefined;
}

/** Every object of a pdf by number: plain objects found by scanning, then those inside object streams. */
function objects(bytes: Uint8Array): Map<number, PdfObject> {
  const found = new Map<number, PdfObject>();
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const lexer = new Lexer(bytes, match.index + match[0].length);
    const value = lexer.item();
    if (value === undefined) { continue; }
    const number = Number(match[1]);
    const dict = dictOf(value);
    const keyword = lexer.value();
    if (dict !== undefined && typeof keyword === 'object' && keyword !== null && 'keyword' in keyword && keyword.keyword === 'stream') {
      let start = lexer.at;
      if (bytes[start] === 0x0d) { start++; }
      if (bytes[start] === 0x0a) { start++; }
      found.set(number, { value, stream: streamBytes(bytes, text, start, dict, found) });
      header.lastIndex = Math.max(header.lastIndex, start);
    } else {
      found.set(number, { value });
    }
  }
  // objects packed in object streams
  for (const object of [...found.values()]) {
    const dict = dictOf(object.value);
    if (nameOf(dict?.get('Type')) !== 'ObjStm' || object.stream === undefined || dict === undefined) { continue; }
    const data = decodeStream(dict, object.stream);
    if (data === undefined) { continue; }
    const count = dict.get('N');
    const first = dict.get('First');
    if (typeof count !== 'number' || typeof first !== 'number') { continue; }
    const head = new Lexer(data);
    const places: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      const number = head.value();
      const offset = head.value();
      if (typeof number !== 'number' || typeof offset !== 'number') { break; }
      places.push([number, offset]);
    }
    for (const [number, offset] of places) {
      if (found.has(number)) { continue; }
      const value = new Lexer(data, first + offset).item();
      if (value !== undefined) { found.set(number, { value }); }
    }
  }
  return found;
}

/** A stream's raw bytes: `Length` long when that is right, else up to its `endstream`. */
function streamBytes(bytes: Uint8Array, text: string, start: number, dict: Dict, found: ReadonlyMap<number, PdfObject>): Uint8Array {
  const given = dict.get('Length');
  const length = typeof given === 'number' ? given : (() => { const ref = refOf(given); const held = ref === undefined ? undefined : found.get(ref)?.value; return typeof held === 'number' ? held : undefined; })();
  if (length !== undefined && start + length <= bytes.length && /^\s*endstream/.test(text.slice(start + length, start + length + 20))) {
    return bytes.subarray(start, start + length);
  }
  const end = text.indexOf('endstream', start);
  let stop = end < 0 ? bytes.length : end;
  if (bytes[stop - 1] === 0x0a) { stop--; }
  if (bytes[stop - 1] === 0x0d) { stop--; }
  return bytes.subarray(start, stop);
}

/** A stream's filters, in order. */
function filtersOf(dict: Dict): string[] {
  const filter = dict.get('Filter');
  const one = nameOf(filter);
  if (one !== undefined) { return [one]; }
  return (arrayOf(filter) ?? []).map(nameOf).filter((name): name is string => name !== undefined);
}

/** A non-image stream decoded (Flate only, and no filter), or `undefined` when it uses another filter. */
function decodeStream(dict: Dict, raw: Uint8Array): Uint8Array | undefined {
  const filters = filtersOf(dict);
  if (filters.length === 0) { return raw; }
  if (filters.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl')) {
    try {
      const inflated = new Uint8Array(inflateSync(raw));
      const params = dictOf(dict.get('DecodeParms'));
      const predictor = params?.get('Predictor');
      if (typeof predictor === 'number' && predictor >= 10) {
        const columns = params?.get('Columns');
        return unfilter(inflated, typeof columns === 'number' ? columns : 1, 1);
      }
      return inflated;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Rows of PNG-filtered samples (each led by its filter byte) back to plain rows. */
function unfilter(data: Uint8Array, rowBytes: number, pixelBytes: number): Uint8Array | undefined {
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let row = 0; row < rows; row++) {
    const type = data[row * (rowBytes + 1)] ?? 0;
    const src = row * (rowBytes + 1) + 1;
    const dst = row * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i] ?? 0;
      const left = i >= pixelBytes ? out[dst + i - pixelBytes] ?? 0 : 0;
      const up = row > 0 ? out[dst - rowBytes + i] ?? 0 : 0;
      const corner = row > 0 && i >= pixelBytes ? out[dst - rowBytes + i - pixelBytes] ?? 0 : 0;
      let value: number;
      switch (type) {
        case 0: value = x; break;
        case 1: value = x + left; break;
        case 2: value = x + up; break;
        case 3: value = x + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - corner;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - corner);
          value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner);
          break;
        }
        default: return undefined;
      }
      out[dst + i] = value & 0xff;
    }
  }
  return out;
}

/** The pages in order: the page tree from the catalog, else every page object in file order. */
function pageDicts(found: ReadonlyMap<number, PdfObject>): Dict[] {
  const get = (value: Value | undefined): Dict | undefined => dictOf(value) ?? (refOf(value) === undefined ? undefined : dictOf(found.get(refOf(value) ?? -1)?.value));
  const catalog = [...found.values()].map((object) => dictOf(object.value)).find((dict) => nameOf(dict?.get('Type')) === 'Catalog');
  const pages: Dict[] = [];
  const seen = new Set<Dict>();
  const walk = (node: Dict | undefined, inherited: Value | undefined, depth: number): void => {
    if (node === undefined || seen.has(node) || depth > 50) { return; }
    seen.add(node);
    const resources = node.get('Resources') ?? inherited;
    if (nameOf(node.get('Type')) === 'Page' || (node.get('Kids') === undefined && node.get('Contents') !== undefined)) {
      pages.push(node.get('Resources') === undefined && resources !== undefined ? new Map([...node, ['Resources', resources]]) : node);
      return;
    }
    for (const kid of arrayOf(node.get('Kids')) ?? []) { walk(get(kid), resources, depth + 1); }
  };
  walk(get(catalog?.get('Pages')), undefined, 0);
  if (pages.length > 0) { return pages; }
  return [...found.values()].map((object) => dictOf(object.value)).filter((dict): dict is Dict => nameOf(dict?.get('Type')) === 'Page');
}

/** The image objects a resources dict holds, looking into form objects one level down. */
function imagesIn(resources: Dict | undefined, found: ReadonlyMap<number, PdfObject>, depth = 0): PdfObject[] {
  const get = (value: Value | undefined): Dict | undefined => dictOf(value) ?? dictOf(found.get(refOf(value) ?? -1)?.value);
  const xobjects = get(resources?.get('XObject'));
  if (xobjects === undefined) { return []; }
  const images: PdfObject[] = [];
  for (const value of xobjects.values()) {
    const object = found.get(refOf(value) ?? -1);
    const dict = dictOf(object?.value);
    if (object === undefined || dict === undefined) { continue; }
    const subtype = nameOf(dict.get('Subtype'));
    if (subtype === 'Image') { images.push(object); }
    if (subtype === 'Form' && depth < 2) { images.push(...imagesIn(get(dict.get('Resources')), found, depth + 1)); }
  }
  return images;
}

/** How many colour channels a colour space has, for the ones a PNG can hold (grey and RGB); else undefined. */
function channelsOf(space: Value | undefined, found: ReadonlyMap<number, PdfObject>): 1 | 3 | undefined {
  const resolved = refOf(space) === undefined ? space : found.get(refOf(space) ?? -1)?.value;
  const name = nameOf(resolved);
  if (name === 'DeviceGray' || name === 'CalGray' || name === 'G') { return 1; }
  if (name === 'DeviceRGB' || name === 'CalRGB' || name === 'RGB') { return 3; }
  const array = arrayOf(resolved);
  if (array !== undefined && nameOf(array[0]) === 'ICCBased') {
    const n = dictOf(found.get(refOf(array[1]) ?? -1)?.value)?.get('N');
    return n === 1 ? 1 : n === 3 ? 3 : undefined;
  }
  if (array !== undefined && (nameOf(array[0]) === 'CalGray' || nameOf(array[0]) === 'CalRGB')) { return nameOf(array[0]) === 'CalGray' ? 1 : 3; }
  return undefined;
}

/** A bitmap's samples, plain rows, or `undefined` when its filters aren't ones this reads. */
function samples(object: PdfObject, rowBytes: number, pixelBytes: number): Uint8Array | undefined {
  const dict = dictOf(object.value);
  if (dict === undefined || object.stream === undefined) { return undefined; }
  const filters = filtersOf(dict);
  if (filters.length > 1 || (filters.length === 1 && filters[0] !== 'FlateDecode' && filters[0] !== 'Fl')) { return undefined; }
  let data: Uint8Array;
  try {
    data = filters.length === 0 ? object.stream : new Uint8Array(inflateSync(object.stream));
  } catch {
    return undefined;
  }
  const params = dictOf(dict.get('DecodeParms'));
  const predictor = params?.get('Predictor');
  if (typeof predictor === 'number' && predictor >= 10) { return unfilter(data, rowBytes, pixelBytes); }
  return data;
}

/** A page's picture: its largest image, as a JPEG or a PNG; `undefined` when there is none this can read. */
function pictureOf(page: number, images: readonly PdfObject[], found: ReadonlyMap<number, PdfObject>): PageImage | undefined {
  const sized = images.flatMap((object) => {
    const dict = dictOf(object.value);
    const width = dict?.get('Width') ?? dict?.get('W');
    const height = dict?.get('Height') ?? dict?.get('H');
    return dict !== undefined && typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 ? [{ object, dict, width, height }] : [];
  }).sort((a, b) => b.width * b.height - a.width * a.height);
  for (const { object, dict, width, height } of sized) {
    const filters = filtersOf(dict);
    if (filters.at(-1) === 'DCTDecode' || filters.at(-1) === 'DCT') {
      if (filters.length !== 1 || object.stream === undefined || channelsOf(dict.get('ColorSpace'), found) === undefined) { continue; }
      return { page, mime: 'image/jpeg', bytes: object.stream, width, height };
    }
    const png = bitmapPng(object, dict, width, height, found);
    if (png !== undefined) { return { page, mime: 'image/png', bytes: png, width, height }; }
  }
  return undefined;
}

/** A compressed bitmap as a PNG: grey or RGB, 1 to 8 bits; an 8-bit soft mask the same size is laid over white. */
function bitmapPng(object: PdfObject, dict: Dict, width: number, height: number, found: ReadonlyMap<number, PdfObject>): Uint8Array | undefined {
  if (width * height > MAX_PIXELS || dict.get('ImageMask') === true) { return undefined; }
  const channels = channelsOf(dict.get('ColorSpace'), found);
  const bits = dict.get('BitsPerComponent');
  if (channels === undefined || typeof bits !== 'number' || ![1, 2, 4, 8].includes(bits) || (channels === 3 && bits !== 8)) { return undefined; }
  const rowBytes = Math.ceil((width * channels * bits) / 8);
  const pixelBytes = Math.max(1, (channels * bits) / 8);
  const data = samples(object, rowBytes, pixelBytes);
  if (data === undefined || data.length < rowBytes * height) { return undefined; }
  const pixels = data.slice(0, rowBytes * height);
  const maskObject = found.get(refOf(dict.get('SMask')) ?? -1);
  const maskDict = dictOf(maskObject?.value);
  if (maskObject !== undefined && maskDict !== undefined && bits === 8 && maskDict.get('Width') === width && maskDict.get('Height') === height && maskDict.get('BitsPerComponent') === 8) {
    const alpha = samples(maskObject, width, 1);
    if (alpha !== undefined && alpha.length >= width * height) {
      for (let i = 0; i < width * height; i++) {
        const a = alpha[i] ?? 255;
        for (let c = 0; c < channels; c++) {
          const at = i * channels + c;
          pixels[at] = Math.round(((pixels[at] ?? 0) * a + 255 * (255 - a)) / 255);
        }
      }
    }
  }
  return encodePng(pixels, width, height, rowBytes, bits, channels === 3 ? 2 : 0);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) { c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8); }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Plain rows of samples as a PNG of one colour type (0 grey, 2 RGB). */
export function encodePng(pixels: Uint8Array, width: number, height: number, rowBytes: number, bits: number, colorType: 0 | 2): Uint8Array {
  const filtered = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row++) { filtered.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1); }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bits;
  header[9] = colorType;
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(filtered))), chunk('IEND', new Uint8Array())]);
}

/** Each page's picture of a pdf (see the module note). Never throws: a pdf this can't read has no pictures. */
export function pdfPictures(bytes: Uint8Array): PdfPictures {
  try {
    const found = objects(bytes);
    const pages = pageDicts(found);
    const get = (value: Value | undefined): Dict | undefined => dictOf(value) ?? dictOf(found.get(refOf(value) ?? -1)?.value);
    return { pages: pages.length, images: pages.map((page, i) => pictureOf(i + 1, imagesIn(get(page.get('Resources')), found), found)) };
  } catch {
    return { pages: 0, images: [] };
  }
}
