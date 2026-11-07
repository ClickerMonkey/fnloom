/**
 * The content slice: presigned uploads (the browser `PUT`s the bytes, then `uploaded` hashes them into a content
 * ref it can send as a `file` part) and transcription. No transcription service is configured yet, so
 * `capabilities.voiceInput` is false and `transcribe` answers 501.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import { contentSlice } from './slices.ts';
import type { authPlugin } from './auth.ts';

/** The content plugin. */
export function contentPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const { content } = hub.api;
  return plugin({ name: 'web.content', spec: contentSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof contentSlice> => ({
      upload: ({ data }) => content.presignUpload({ mime: data.mime, size: data.size }),
      uploaded: async ({ data, user }) => {
        const ref = await content.finish(data.upload);
        hub.log.info('content.uploaded', { user: user.id, hash: ref.hash, size: ref.size });
        return ref;
      },
      transcribe: () => { throw reject(501, 'NO_TRANSCRIPTION', 'no transcription service is configured'); },
    }));
}
