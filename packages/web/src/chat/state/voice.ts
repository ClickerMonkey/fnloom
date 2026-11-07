/**
 * Voice dictation: record from the microphone, upload the audio, have the hub transcribe it, and hand the text back
 * for the composer to drop at the caret. The microphone is a `Recorder`, so tests use a fake one; the browser's is
 * `MediaRecorderSource`.
 */
import type { ContentRef } from '@harness/core';
import { ref } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** A microphone that records one clip at a time. */
export interface Recorder {
  /** Start recording. Rejects with a `NotAllowedError` DOMException when permission is denied. */
  start(): Promise<void>;
  /** Stop and return the clip. */
  stop(): Promise<Blob>;
  /** Stop and throw the clip away. */
  cancel(): void;
}

/** Records with the browser's `MediaRecorder`. */
export class MediaRecorderSource implements Recorder {
  #recorder: MediaRecorder | undefined;
  #chunks: Blob[] = [];

  /** Whether this browser can record. */
  static available(): boolean {
    return typeof navigator !== 'undefined' && 'mediaDevices' in navigator && typeof navigator.mediaDevices.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.#chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => { if (event.data.size > 0) { this.#chunks.push(event.data); } };
    recorder.start();
    this.#recorder = recorder;
  }

  stop(): Promise<Blob> {
    const recorder = this.#recorder;
    if (recorder === undefined) { return Promise.reject(new Error('Not recording.')); }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        for (const track of recorder.stream.getTracks()) { track.stop(); }
        resolve(new Blob(this.#chunks, { type: recorder.mimeType === '' ? 'audio/webm' : recorder.mimeType }));
      };
      recorder.stop();
      this.#recorder = undefined;
    });
  }

  cancel(): void {
    const recorder = this.#recorder;
    if (recorder === undefined) { return; }
    recorder.onstop = () => { for (const track of recorder.stream.getTracks()) { track.stop(); } };
    recorder.stop();
    this.#recorder = undefined;
  }
}

/** Where dictation is. */
export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'denied' | 'failed';

/** Dictation for the composer. */
export class VoiceStore {
  readonly #recorder: Recorder;
  readonly #upload: (clip: Blob) => Promise<ContentRef>;
  readonly #api: Pick<ChatApi, 'transcribe'>;
  readonly #clock: () => number;

  readonly state = ref<VoiceState>('idle');
  /** When recording started, for the elapsed time. */
  readonly startedAt = ref(0);
  readonly problem = ref('');

  constructor(recorder: Recorder, upload: (clip: Blob) => Promise<ContentRef>, api: Pick<ChatApi, 'transcribe'>, clock: () => number = Date.now) {
    this.#recorder = recorder;
    this.#upload = upload;
    this.#api = api;
    this.#clock = clock;
  }

  async start(): Promise<void> {
    if (this.state.value === 'recording' || this.state.value === 'transcribing') { return; }
    this.problem.value = '';
    try {
      await this.#recorder.start();
      this.startedAt.value = this.#clock();
      this.state.value = 'recording';
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      this.state.value = denied ? 'denied' : 'failed';
      this.problem.value = denied
        ? 'The microphone is blocked. Allow it in your browser’s site settings to dictate.'
        : "Couldn't start the microphone.";
    }
  }

  /** Stop recording and transcribe; resolves with the text (undefined when it failed). */
  async stop(): Promise<string | undefined> {
    if (this.state.value !== 'recording') { return undefined; }
    this.state.value = 'transcribing';
    try {
      const clip = await this.#recorder.stop();
      const audio = await this.#upload(clip);
      const { text } = await this.#api.transcribe.call({ audio });
      this.state.value = 'idle';
      return text;
    } catch (error) {
      this.state.value = 'failed';
      this.problem.value = problemText(error, "Couldn't transcribe that.");
      return undefined;
    }
  }

  cancel(): void {
    if (this.state.value === 'recording') { this.#recorder.cancel(); }
    this.state.value = 'idle';
  }

  /** Put away a problem message. */
  dismiss(): void {
    this.problem.value = '';
    if (this.state.value === 'denied' || this.state.value === 'failed') { this.state.value = 'idle'; }
  }
}
