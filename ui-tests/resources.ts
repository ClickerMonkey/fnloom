/**
 * Resources the resource features look at: one sample file of each common type (`packages/web/e2e/samples.ts`),
 * uploaded to the hub under test as hub resources the first time and found by name afterwards, so every run sees
 * the same set.
 */
import type { ResourceRecord, ResourceUri } from '@harness/core';
import { sampleFiles } from '../packages/web/e2e/samples.ts';
import type { SignedIn } from '../scripts/hub-client.ts';

/** The sample resources by file name (`ui-sample.png`). */
export type Samples = Readonly<Record<string, ResourceUri>>;

/** Upload one sample through the hub's presigned upload, then import it as a hub resource. */
async function upload(api: SignedIn, base: string, file: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array }): Promise<ResourceRecord> {
  const { url, upload: id } = await api.hub.call('upload', { name: file.name, mime: file.mime, size: file.bytes.length });
  const put = await fetch(new URL(url, base), { method: 'PUT', body: new Uint8Array(file.bytes), headers: { 'content-type': file.mime } });
  if (!put.ok) { throw new Error(`uploading ${file.name} answered ${put.status}`); }
  const content = await api.hub.call('uploaded', { upload: id });
  return api.hub.call('importResource', { content, name: file.name });
}

/** The sample resources on the hub, uploading the ones it doesn't have yet. */
export async function samples(api: SignedIn, base: string): Promise<Samples> {
  const page = await api.hub.call('browseResources', { search: 'ui-sample', limit: 50 });
  const found = new Map(page.items.map((r) => [r.stat.name, r.uri]));
  for (const file of sampleFiles()) {
    if (!found.has(file.name)) { found.set(file.name, (await upload(api, base, file)).uri); }
  }
  return Object.fromEntries(found);
}

/** One sample's URI, failing the feature when it is missing. */
export function sample(all: Samples, name: string): ResourceUri {
  const found = all[name];
  if (found === undefined) { throw new Error(`no sample resource ${name}`); }
  return found;
}
