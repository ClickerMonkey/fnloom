/**
 * "What would this message get?": a dry run of the session's contextor for a draft, answered with the selection and
 * budget report the real prompt would carry, without calling the model. One per session, kept while the settings
 * panel is open.
 */
import type { SelectionReport, SessionId } from '@harness/core';
import { ref } from 'vue';
import { Loaded } from '../../state/loaded.ts';
import type { ChatApi } from '../api.ts';

/** A session's selection preview. */
export class SelectionPreview {
  readonly #api: Pick<ChatApi, 'previewSelection'>;
  readonly #session: SessionId;
  readonly report = new Loaded<SelectionReport>();
  /** The text the shown report was made for. */
  readonly text = ref('');

  constructor(api: Pick<ChatApi, 'previewSelection'>, session: SessionId) {
    this.#api = api;
    this.#session = session;
  }

  /** Ask what `text` would get now. Blank text asks nothing. */
  async preview(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') { return; }
    this.text.value = trimmed;
    await this.report.load(() => this.#api.previewSelection.call({ session: this.#session, text: trimmed }), "Couldn't preview this message.");
  }

  clear(): void {
    this.text.value = '';
    this.report.reset();
  }
}
