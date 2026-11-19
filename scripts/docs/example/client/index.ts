/**
 * The notes system's renderers, typed by its contract: the `find` card, the `review` form, the note attachment, the
 * editor and viewer of `notes/Note`, a resource view for markdown, and the Notes page. The chat loads this module from
 * the hub and provides each renderer's `system`.
 */
// typescript-eslint can't see the types of .vue modules from .ts files; vue-tsc checks this file
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// #region client
import { client } from '@harness/sdk';
import { notes } from '../shared/index.ts';
import FindView from './FindView.vue';
import NoteCard from './NoteCard.vue';
import NoteInput from './NoteInput.vue';
import NotesPage from './NotesPage.vue';
import ReviewForm from './ReviewForm.vue';
import WordCount from './WordCount.vue';

export default client(notes, {
  fns: { find: FindView, review: ReviewForm },
  attachments: { note: NoteCard },
  inputs: { Note: NoteInput },
  // a tab beside the hub's preview of every markdown resource; `mode: 'replace'` would draw instead of the preview
  resources: { markdown: { component: WordCount, mode: 'tab', label: 'Words' } },
  // the page the contract's `pages` names, at /s/notes/notes
  pages: { NotesPage },
});
// #endregion client
