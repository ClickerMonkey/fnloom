/**
 * The hub's side of the LLM wire. The mapping between aeye's in-memory LLM shapes and their JSON projections in core
 * is `@harness/sdk/server`'s, shared with systems; this module adds what only the hub needs: the text of a tool reply,
 * token totals, and the lenient mapping it saves transcripts and interactions with. (A fn's tool name is core's
 * `modelFnName`, the one name the model sees.)
 */
import type { Message, Request } from '@aeye/core';
import { ChangeSet, LoadCards, ResultTable, rowsLine, tableModelView, WidgetProposal, WidgetResult, type Json, type LlmMessage, type TableModelView, type TableReading, type LlmRequest, type LlmUsage } from '@harness/core';
import { LlmWire } from '@harness/sdk/server';

export {
  AnswerDecoder, ChunkReader, ChunkWriter, chunkFromWire, chunkToWire, isObjectSchema, messageFromWire, requestFromWire, responseToWire, usageToWire,
} from '@harness/sdk/server';

/**
 * What the hub saves: a record never fails over something the wire can't carry (a streamed part is kept as
 * `[binary content]`), and a request a provider planned keeps its schemas as the model was sent them (its dialect, the
 * dispatcher in place of the tools behind it); one not planned yet, lenient.
 */
const recorded = new LlmWire({ unrepresentable: 'placeholder', schemas: 'sent' });

/** An aeye message as it is saved. Provider caches and reasoning details stay behind. */
export function messageToWire(message: Message): LlmMessage {
  return recorded.message(message);
}

/** An aeye request as it is saved with its interaction. */
export function requestToWire(request: Request): LlmRequest {
  return recorded.request(request);
}

/**
 * The text of a tool reply the model reads: strings as they are, anything else as JSON (as aeye writes them). A
 * command's change set (`changes`, `core/changes.ts`, from fs `bash`) is listed file by file without its diffs: the
 * run keeps it whole for the run view's diff tabs, and the model reads a file when it needs the content. A table
 * result (a widget run, a fn returning a `ResultTable`) is drawn for the person when someone watches the run, so the
 * model reads its summary and the first `reading.rows` rows (`tableModelView`), told who sees the rest; a widget
 * proposal (`widgets/make_widget`) the same of its preview, with a line saying it waits for the person's Save. A hub load
 * (`hub/fns_load`, `hub/ctx_load`) is read as its XML cards (`LoadCards`), never its record's name lists. `encode` is
 * how a value read as JSON goes to the model (the one fn name's `ModelFnNames.value`: its fn-name fields as the model
 * calls those fns); the shapes above are read from the value as the fn gave it.
 */
export function replyText(value: Json, reading: TableReading, encode: (value: Json) => Json = (plain) => plain): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return JSON.stringify(encode(value));
  const load = LoadCards.safeParse(value);
  if (load.success) return load.data.cards;
  const table = tableReply(value, reading);
  if (table !== undefined) return JSON.stringify(table);
  const { changes, ...rest } = value;
  const set = ChangeSet.safeParse(changes);
  return set.success ? `${JSON.stringify(encode(rest))}\n${changeSummary(set.data)}` : JSON.stringify(encode(value));
}

/** A widget proposal as the model reads it: its preview's view plus a line saying it waits for the person's Save. */
interface ProposalModelView extends TableModelView {
  readonly proposed: string;
  readonly saved: string;
}

/** A widget proposal's, a widget's or a table's result as the model reads it, or undefined for anything else. */
function tableReply(value: Json, reading: TableReading): TableModelView | ProposalModelView | undefined {
  const proposal = WidgetProposal.safeParse(value);
  if (proposal.success) {
    const { name, description, preview, replaces } = proposal.data;
    return {
      proposed: `${name}: ${description}${replaces === undefined ? '' : ` (changes ${replaces})`}`,
      saved: 'Proposed, not saved: the person sees the preview and presses Save to keep it.',
      ...tableModelView(preview.summary, preview.table, reading),
    };
  }
  const widget = WidgetResult.safeParse(value);
  if (widget.success) return tableModelView(widget.data.summary, widget.data.table, reading);
  const table = ResultTable.safeParse(value);
  if (!table.success) return undefined;
  return tableModelView(`A table of ${rowsLine(table.data)}`, table.data, reading);
}

/** A change set in a few lines: each file, how it changed and by how many lines, and what was left out. */
export function changeSummary(set: ChangeSet): string {
  if (set.files.length === 0 && set.ignored === 0) return 'Changed files: none.';
  const lines = set.files.map((file) => {
    const counts = file.added === undefined && file.removed === undefined ? '' : ` (+${String(file.added ?? 0)} -${String(file.removed ?? 0)})`;
    const from = file.from === undefined ? '' : ` from ${file.from}`;
    const why = file.noDiff === undefined ? '' : `, no diff: ${file.noDiff}`;
    const unsure = file.certain ? '' : ', maybe the change of another call';
    return `- ${file.status} ${file.root}:${file.path}${from}${counts}${why}${unsure}`;
  });
  const more = [
    ...(set.truncated ? ['more files changed than are listed'] : []),
    ...(set.ignored > 0 ? [`${String(set.ignored)} ignored by git`] : []),
  ];
  return [`Changed files (${set.source}):`, ...lines, ...(more.length === 0 ? [] : [`(${more.join('; ')})`])].join('\n');
}

/** The tokens a call used, for the ledger. */
export function tokensOf(usage: LlmUsage): number {
  return usage.input + usage.output + (usage.reasoning ?? 0);
}
