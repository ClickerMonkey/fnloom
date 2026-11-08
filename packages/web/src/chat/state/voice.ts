/**
 * Voice dictation for the composer, by the engine the hub's dictation role says (`ChatCapabilities.dictation`):
 * - `model`: record from the microphone, upload the clip, and have the hub transcribe it with the dictation model
 *   (`RecordedDictation`, over a `Recorder`; the browser's is `MediaRecorderSource`);
 * - `browser`: the browser's own speech recognition, no model call (`SpeechDictation`, over a `SpeechRecognizer`).
 * Both are a `Dictation`, so `VoiceStore` runs either the same way and tests use fakes of each.
 */
import type { ChatCapabilities, ContentRef } from '@harness/core';
import { ref } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** The dictation engines, as the hub names them. */
export type DictationEngineName = NonNullable<ChatCapabilities['dictation']>['engine'];

/** One way of turning speech into text: start listening, then stop for the text (or cancel for none). */
export interface Dictation {
  /** Start listening. Rejects with a `NotAllowedError` DOMException when the microphone is refused. */
  start(language?: string): Promise<void>;
  /** Stop and give the text heard. */
  stop(): Promise<string>;
  /** Stop and throw away what was heard. */
  cancel(): void;
}

// ─── The model engine: record, upload, transcribe ─────────────────────────────

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

/** Dictation by the hub's dictation model: the clip is uploaded and transcribed by the hub (one model call). */
export class RecordedDictation implements Dictation {
  readonly #recorder: Recorder;
  readonly #upload: (clip: Blob) => Promise<ContentRef>;
  readonly #api: Pick<ChatApi, 'transcribe'>;

  constructor(recorder: Recorder, upload: (clip: Blob) => Promise<ContentRef>, api: Pick<ChatApi, 'transcribe'>) {
    this.#recorder = recorder;
    this.#upload = upload;
    this.#api = api;
  }

  start(): Promise<void> {
    return this.#recorder.start();
  }

  async stop(): Promise<string> {
    const clip = await this.#recorder.stop();
    const audio = await this.#upload(clip);
    return (await this.#api.transcribe.call({ audio })).text;
  }

  cancel(): void {
    this.#recorder.cancel();
  }
}

// ─── The browser engine: its speech recognition ───────────────────────────────

/** What dictation needs of the browser's speech recognition (the Web Speech API's `SpeechRecognition`). */
export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }> }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** Makes a speech recognizer. */
export type SpeechRecognizerFactory = () => SpeechRecognizer;

/** The browser's speech recognition, where it has one (`SpeechRecognition`, or WebKit's prefixed one). */
export function browserSpeech(win: Window): SpeechRecognizerFactory | undefined {
  const made: unknown = Reflect.get(win, 'SpeechRecognition') ?? Reflect.get(win, 'webkitSpeechRecognition');
  if (typeof made !== 'function') { return undefined; }
  return () => {
    const recognizer: unknown = Reflect.construct(made, []);
    if (!isRecognizer(recognizer)) { throw new Error('This browser’s speech recognition is not usable.'); }
    return recognizer;
  };
}

function isRecognizer(value: unknown): value is SpeechRecognizer {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'start') === 'function' && typeof Reflect.get(value, 'stop') === 'function';
}

/** The speech errors that mean the microphone was refused. */
const REFUSED = new Set(['not-allowed', 'service-not-allowed']);

/** Dictation by the browser's speech recognition: no upload and no model call. */
export class SpeechDictation implements Dictation {
  readonly #make: SpeechRecognizerFactory;
  #recognizer: SpeechRecognizer | undefined;
  #heard: string[] = [];
  #error: string | undefined;
  #ended: (() => void) | undefined;

  constructor(make: SpeechRecognizerFactory) {
    this.#make = make;
  }

  start(language?: string): Promise<void> {
    const recognizer = this.#make();
    this.#heard = [];
    this.#error = undefined;
    recognizer.lang = language ?? '';
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.onresult = (event) => {
      this.#heard = Array.from(event.results).filter((result) => result.isFinal).map((result) => result[0]?.transcript.trim() ?? '');
    };
    recognizer.onend = () => { this.#ended?.(); };
    return new Promise((resolve, reject) => {
      recognizer.onerror = (event) => {
        this.#error = event.error;
        if (REFUSED.has(event.error)) { reject(new DOMException('The microphone is blocked.', 'NotAllowedError')); }
      };
      recognizer.start();
      this.#recognizer = recognizer;
      resolve();
    });
  }

  stop(): Promise<string> {
    const recognizer = this.#recognizer;
    if (recognizer === undefined) { return Promise.reject(new Error('Not listening.')); }
    this.#recognizer = undefined;
    return new Promise((resolve, reject) => {
      this.#ended = () => {
        this.#ended = undefined;
        if (this.#error !== undefined && this.#error !== 'no-speech' && this.#heard.length === 0) { reject(new Error(`Speech recognition failed (${this.#error}).`)); return; }
        resolve(this.#heard.filter((part) => part !== '').join(' '));
      };
      recognizer.stop();
    });
  }

  cancel(): void {
    this.#ended = undefined;
    this.#recognizer?.abort();
    this.#recognizer = undefined;
  }
}

// ─── The store ────────────────────────────────────────────────────────────────

/** Where dictation is. */
export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'denied' | 'failed';

/** The engines this browser can run (an engine it can't is left out). */
export type DictationEngines = Partial<Record<DictationEngineName, Dictation>>;

/** Dictation for the composer, by whichever engine the hub picked. */
export class VoiceStore {
  readonly #engines: DictationEngines;
  readonly #clock: () => number;
  #active: Dictation | undefined;

  readonly state = ref<VoiceState>('idle');
  /** When recording started, for the elapsed time. */
  readonly startedAt = ref(0);
  readonly problem = ref('');

  constructor(engines: DictationEngines, clock: () => number = Date.now) {
    this.#engines = engines;
    this.#clock = clock;
  }

  /** Whether this browser can dictate with an engine. */
  can(engine: DictationEngineName): boolean {
    return this.#engines[engine] !== undefined;
  }

  /** Start listening with an engine (in a BCP 47 language, when the hub's role names one). */
  async start(engine: DictationEngineName, language?: string): Promise<void> {
    if (this.state.value === 'recording' || this.state.value === 'transcribing') { return; }
    this.problem.value = '';
    const dictation = this.#engines[engine];
    if (dictation === undefined) {
      this.state.value = 'failed';
      this.problem.value = engine === 'browser' ? 'This browser can’t recognise speech. An admin can switch dictation to a model.' : 'This browser can’t record audio.';
      return;
    }
    try {
      await dictation.start(language);
      this.#active = dictation;
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

  /** Stop and turn what was heard into text; resolves with the text (undefined when it failed). */
  async stop(): Promise<string | undefined> {
    const dictation = this.#active;
    if (this.state.value !== 'recording' || dictation === undefined) { return undefined; }
    this.#active = undefined;
    this.state.value = 'transcribing';
    try {
      const text = await dictation.stop();
      this.state.value = 'idle';
      return text;
    } catch (error) {
      this.state.value = 'failed';
      this.problem.value = problemText(error, "Couldn't transcribe that.");
      return undefined;
    }
  }

  cancel(): void {
    if (this.state.value === 'recording') { this.#active?.cancel(); }
    this.#active = undefined;
    this.state.value = 'idle';
  }

  /** Put away a problem message. */
  dismiss(): void {
    this.problem.value = '';
    if (this.state.value === 'denied' || this.state.value === 'failed') { this.state.value = 'idle'; }
  }
}
