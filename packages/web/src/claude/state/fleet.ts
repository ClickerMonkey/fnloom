/**
 * The Claude fleet page's state: the person's sessions (`claude/Session` records, searched, filtered and sorted by the
 * hub) a page at a time, read again quietly while the page is open; and starting a new session, which runs
 * `claude/start_session` in a chat made for it and gives the session once it is live (a start that stops for approval
 * is answered in the dialog, from that chat's approvals).
 */
import { ClaudeTurn, jsonOf, type ClaudeSessionRef } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import type { DataStore } from '../../data/state/data.ts';
import { problemText } from '../../state/problems.ts';
import { CLAUDE_FNS, FLEET_PAGE, fleetQuery, folderName, sessionsOf, startArgs, type FleetSession, type FleetUrl, type StartDraft } from '../logic/claude.ts';
import { ClaudeRuns, type RunsChat } from './runs.ts';

/** The fleet list. */
export class ClaudeFleet {
  readonly #data: Pick<DataStore, 'findRecords'>;
  #url: FleetUrl = {};
  #cursor: string | undefined;
  #generation = 0;
  readonly items = shallowRef<readonly FleetSession[]>([]);
  readonly loading = ref(false);
  readonly loadingMore = ref(false);
  readonly loaded = ref(false);
  readonly problem = ref('');
  readonly hasMore = ref(false);

  constructor(data: Pick<DataStore, 'findRecords'>) {
    this.#data = data;
  }

  /** Show the sessions under these filters, from the first page. */
  async show(url: FleetUrl): Promise<void> {
    this.#url = url;
    this.loading.value = true;
    await this.#first();
    this.loading.value = false;
  }

  /** Read the first page again without the loading state; skipped once more pages are shown (they'd be cut). */
  async refresh(): Promise<void> {
    if (this.items.value.length > FLEET_PAGE || this.loadingMore.value) { return; }
    await this.#first();
  }

  /** The next page, added under the ones shown. */
  async more(): Promise<void> {
    if (this.#cursor === undefined || this.loadingMore.value) { return; }
    const generation = this.#generation;
    this.loadingMore.value = true;
    try {
      const page = await this.#data.findRecords(fleetQuery(this.#url, this.#cursor));
      if (generation !== this.#generation) { return; }
      this.items.value = [...this.items.value, ...sessionsOf(page.items)];
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't read more sessions.");
    } finally {
      this.loadingMore.value = false;
    }
  }

  async #first(): Promise<void> {
    const generation = ++this.#generation;
    try {
      const page = await this.#data.findRecords(fleetQuery(this.#url));
      if (generation !== this.#generation) { return; }
      this.items.value = sessionsOf(page.items);
      this.#cursor = page.cursor;
      this.hasMore.value = page.cursor !== undefined;
      this.problem.value = '';
      this.loaded.value = true;
    } catch (error) {
      if (generation === this.#generation) { this.problem.value = problemText(error, "Couldn't read your Claude sessions."); }
    }
  }
}

/** Where starting a session is: being typed, sent (and maybe waiting for approval), or failed. */
export type StartPhase = 'typing' | 'starting' | 'approval';

/** Starting one session. */
export class ClaudeStarter {
  readonly #chat: RunsChat;
  #runs: ClaudeRuns | undefined;
  readonly phase = ref<StartPhase>('typing');
  readonly problems = shallowRef<Readonly<Record<string, string>>>({});
  readonly problem = ref('');
  /** The chat the start runs in, once made: its approvals are answered in the dialog. */
  readonly runs = shallowRef<ClaudeRuns | undefined>(undefined);
  readonly busy = computed(() => this.phase.value !== 'typing');

  constructor(chat: RunsChat) {
    this.#chat = chat;
  }

  /** Start a session from the form; the session once it is live, else undefined (with `problems` or `problem` set). */
  async start(draft: StartDraft): Promise<ClaudeSessionRef | undefined> {
    const checked = startArgs(draft);
    if (!checked.ok) { this.problems.value = checked.problems; return undefined; }
    this.problems.value = {};
    this.problem.value = '';
    this.phase.value = 'starting';
    const title = checked.args.title ?? folderName(checked.args.folder);
    const runs = new ClaudeRuns(this.#chat, () => `Claude: ${title}`);
    this.#runs?.close();
    this.#runs = runs;
    this.runs.value = runs;
    const outcome = await runs.run(CLAUDE_FNS.start, jsonOf(checked.args), () => { this.phase.value = 'approval'; }, checked.on);
    this.phase.value = 'typing';
    if (!outcome.ok) { this.problem.value = outcome.problem; return undefined; }
    const turn = ClaudeTurn.safeParse(outcome.output);
    if (!turn.success) { this.problem.value = 'The session started, but its answer could not be read.'; return undefined; }
    return { instance: turn.data.instance, session: turn.data.session };
  }

  /** Stop listening to the start's chat (the dialog closed or the page left). */
  close(): void {
    this.#runs?.close();
    this.#runs = undefined;
    this.runs.value = undefined;
    this.phase.value = 'typing';
  }
}
