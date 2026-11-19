/**
 * The content slice: presigned uploads (the browser `PUT`s the bytes, then `uploaded` hashes them into a content
 * ref it can send as a `file` part) and dictation: an uploaded recording is heard by the dictation role's model
 * (`hub.models.roles`, `dictate` with the model engine), through the model gateway, so it is recorded as a
 * `ModelCall` like every model call. While dictation is in the browser or off, `transcribe` answers 501.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { contentSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** What dictation recordings are recorded as (their `ModelCall.purpose`). */
export const DICTATION_PURPOSE = 'dictation';

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
      transcribe: async ({ data, user, signal }) => {
        const role = await hub.models.roles.get('dictate');
        const resolved = role.resolved !== undefined && 'model' in role.resolved ? role.resolved : undefined;
        if (resolved === undefined) { throw reject(501, 'NO_TRANSCRIPTION', 'dictation has no transcription model (an admin chooses one under model roles)'); }
        if (!data.audio.mime.startsWith('audio/')) { throw reject(422, 'NOT_AUDIO', `a recording is audio, not ${data.audio.mime}`); }
        const language = role.choice?.role === 'dictate' ? role.choice.language : undefined;
        const heard = await hub.models.gateway.forward({
          modality: 'transcribe', audio: data.audio, ...(language === undefined ? {} : { language }),
        }, { purpose: DICTATION_PURPOSE }, signal, 'dictate');
        if (heard.modality !== 'transcribe') { throw new Error('the transcription answered with another modality'); }
        hub.log.info('content.transcribed', { user: user.id, size: data.audio.size, characters: heard.text.length, call: heard.call });
        return { text: heard.text };
      },
    }));
}
