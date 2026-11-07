import { createHash } from 'node:crypto';
import { ApiError, server, spec } from '@ayepi/core';
import { mountFiles } from '@ayepi/files/server';
import { describe, expect, it } from 'vitest';
import { contentKey, FileContentStore, hashStream, NamedContentFiles, sliceStream } from './files.ts';
import { MemoryFiles } from './testing/rig.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) { controller.enqueue(bytes(chunk)); } controller.close(); } });
}

function make(maxUpload = 1_000) {
  const raw = new MemoryFiles();
  const files = new NamedContentFiles(raw);
  const app = server(spec({ endpoints: {} }), []);
  const { presign } = mountFiles(app, files, { secret: 'files-secret-files-secret-files-secret-01' });
  const content = new FileContentStore({ files, presign, maxUpload, presignTtl: 60_000, clock: () => 0 });
  const put = (url: string, body: string) => app.fetch(new Request(`http://hub${url}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } }));
  return { raw, app, content, put };
}

describe('sliceStream and hashStream', () => {
  it('reads a window across chunk edges', async () => {
    const text = new TextDecoder();
    expect(text.decode(await sliceStream(streamOf(['abc', 'def', 'ghi']), 2, 5))).toBe('cdefg');
    expect(text.decode(await sliceStream(streamOf(['abc']), 1, 10))).toBe('bc');
    expect((await sliceStream(streamOf(['abc']), 5, 2)).length).toBe(0);
  });

  it('hashes and counts a stream', async () => {
    await expect(hashStream(streamOf(['ab', 'c']))).resolves.toEqual({ hash: sha('abc'), size: 3 });
  });
});

describe('FileContentStore', () => {
  it('stores bytes once under their hash and reads them back in pieces', async () => {
    const { raw, content } = make();
    const ref = await content.put(bytes('hello world'), 'text/plain');
    expect(ref).toEqual({ hash: sha('hello world'), size: 11, mime: 'text/plain' });
    await content.put(bytes('hello world'), 'text/plain');
    expect([...raw.objects.keys()]).toEqual([contentKey(ref.hash)]);
    await expect(content.has(ref)).resolves.toBe(true);
    expect(new TextDecoder().decode(await content.read(ref, 6, 5))).toBe('world');
    const opened = await content.open(ref.hash);
    expect(opened?.size).toBe(11);
    await expect(content.open('not-a-hash')).resolves.toBeUndefined();
  });

  it('refuses to read content it does not have', async () => {
    const { content } = make();
    await expect(content.read({ hash: sha('nothing'), size: 1, mime: 'x' }, 0, 1)).rejects.toBeInstanceOf(ApiError);
  });

  it('takes a presigned upload, hashes it into content and forgets the upload', async () => {
    const { raw, content, put } = make();
    const { url, upload } = await content.presignUpload({ mime: 'image/png', size: 5 });
    expect((await put(url, 'pixel')).status).toBe(200);
    const ref = await content.finish(upload);
    expect(ref).toEqual({ hash: sha('pixel'), size: 5, mime: 'image/png' });
    expect([...raw.objects.keys()]).toEqual([contentKey(ref.hash)]);
    await expect(content.finish(upload)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an upload of another size than declared, and one over the limit', async () => {
    const { raw, content, put } = make(10);
    const { url, upload } = await content.presignUpload({ mime: 'text/plain', size: 3 });
    await put(url, 'four');
    await expect(content.finish(upload)).rejects.toMatchObject({ status: 422 });
    expect(raw.objects.size).toBe(0);
    await expect(content.presignUpload({ mime: 'text/plain', size: 11 })).rejects.toMatchObject({ status: 413 });
  });

  it('refuses finishing an upload that never came or a bad id', async () => {
    const { content } = make();
    const { upload } = await content.presignUpload({ mime: 'text/plain', size: 3 });
    await expect(content.finish(upload)).rejects.toMatchObject({ status: 409 });
    await expect(content.finish('../escape')).rejects.toMatchObject({ status: 400 });
  });

  it('sweeps away uploads that expired unfinished', async () => {
    let now = 0;
    const raw = new MemoryFiles();
    const files = new NamedContentFiles(raw);
    const app = server(spec({ endpoints: {} }), []);
    const { presign } = mountFiles(app, files, { secret: 'files-secret-files-secret-files-secret-01' });
    const content = new FileContentStore({ files, presign, maxUpload: 100, presignTtl: 1_000, clock: () => now });
    const old = await content.presignUpload({ mime: 'text/plain', size: 1 });
    now = 500;
    await content.presignUpload({ mime: 'text/plain', size: 1 });
    now = 1_200;
    await expect(content.sweep()).resolves.toBe(1);
    await expect(content.finish(old.upload)).rejects.toMatchObject({ status: 404 });
    expect([...raw.objects.keys()]).toHaveLength(1);
  });

  it('presigns a download that saves under its own name', async () => {
    const { app, content } = make();
    const ref = await content.put(bytes('report'), 'text/csv');
    const url = await content.presignDownload(ref, 'q3/report.csv');
    const res = await app.fetch(new Request(`http://hub${url}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('q3_report.csv');
    expect(await res.text()).toBe('report');
  });
});
