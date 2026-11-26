import { describe, expect, it } from 'vitest';
import { detectMime, imagePartProblem, looksLikeText, mimeOfName, sniffMime } from './media-types.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n');
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

describe('what content is, from its bytes first', () => {
  it('tells pictures, documents and recordings by their first bytes', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(text('GIF89a....'))).toBe('image/gif');
    expect(sniffMime(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(text('RIFF\0\0\0\0WAVEfmt '))).toBe('audio/wav');
    expect(sniffMime(text('ID3\u0003\0\0\0'))).toBe('audio/mpeg');
    expect(sniffMime(text('OggS\0\u0002'))).toBe('audio/ogg');
    expect(sniffMime(text('fLaC\0\0\0\u0022'))).toBe('audio/flac');
    expect(sniffMime(text('\0\0\0\u0020ftypM4A \0\0\0\0'))).toBe('audio/mp4');
    expect(sniffMime(text('\0\0\0\u0020ftypisom\0\0\0\0'))).toBe('video/mp4');
    expect(sniffMime(text('\0\0\0\u0020ftypheic\0\0\0\0'))).toBe('image/heic');
    expect(sniffMime(text('just some notes'))).toBeUndefined();
    expect(sniffMime(new Uint8Array())).toBeUndefined();
  });

  it('reads a name\'s extension in any case', () => {
    expect(mimeOfName('IMG_2890.JPG')).toBe('image/jpeg');
    expect(mimeOfName('C:/Users/x/Pictures/Photo.JpEg')).toBe('image/jpeg');
    expect(mimeOfName('Report.PDF')).toBe('application/pdf');
    expect(mimeOfName('README')).toBeUndefined();
  });

  it('trusts the bytes over the name, and the name over a guess', () => {
    expect(detectMime(JPEG, 'IMG_2890.JPG')).toBe('image/jpeg');
    expect(detectMime(JPEG, 'notes.txt')).toBe('image/jpeg');
    expect(detectMime(PDF, 'scan0001')).toBe('application/pdf');
    // a text file named like a picture is not a picture
    expect(detectMime(text('not really a photo'), 'photo.jpg')).toBe('text/plain; charset=utf-8');
    expect(detectMime(text('# Notes'), 'notes.md')).toBe('text/markdown');
    // bytes nobody knows keep what the name says, unless the name says text
    expect(detectMime(new Uint8Array([0, 1, 2, 3]), 'clip.heic')).toBe('image/heic');
    expect(detectMime(new Uint8Array([0, 1, 2, 3]), 'notes.txt')).toBe('application/octet-stream');
    expect(detectMime(new Uint8Array([0, 1, 2, 3]))).toBe('application/octet-stream');
  });

  it('counts UTF-8 as text, a character cut at the edge of the look included', () => {
    expect(looksLikeText(text('café'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0xc3]))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x61, 0x00]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });
});

describe('what may go to a model as a picture', () => {
  it('lets through links and real pictures of the kinds providers take', () => {
    expect(imagePartProblem('https://example.com/a.png')).toBeUndefined();
    expect(imagePartProblem(dataUrl('image/jpeg', JPEG))).toBeUndefined();
    expect(imagePartProblem(dataUrl('image/png', PNG))).toBeUndefined();
  });

  it('says why anything else is not a picture', () => {
    // what a JPEG served as text became: an empty data URL of text
    expect(imagePartProblem('data:text/plain; charset=utf-8;base64,')).toBe('it is empty (it says text/plain)');
    expect(imagePartProblem(dataUrl('image/jpeg', text('hello')))).toBe('its bytes are not a picture (it says image/jpeg)');
    expect(imagePartProblem(dataUrl('text/plain', JPEG))).toBe('it says text/plain but its bytes are image/jpeg');
    expect(imagePartProblem(dataUrl('image/tiff', new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2])))).toBe("it is image/tiff, a kind of picture the model can't be sent");
    expect(imagePartProblem('data:image/png,rawtext')).toBe("its data isn't base64 (it says image/png)");
    expect(imagePartProblem('C:/photo.jpg')).toBe('it is not a picture link or picture data');
  });
});
