/**
 * A scripted Claude for tests: no process, no model, no credits. Each opened session records what it was sent and
 * told, and a test drives it through its listener as Claude would: `emit` an event, `permit` a tool use or `question`
 * a question (each resolves with what the person decided). Claude's store is a list the test fills.
 */
import type { ClaudePermissionMode, ClaudeSessionId, ClaudeTranscriptItem } from '@harness/core';
import type { ClaudeDriver, DriverEvent, DriverOpen, DriverPage, FoundImportable, LiveSession, PermitDecision, PermitRequest, QuestionReply, QuestionRequest, SessionListener, StoredSession } from './driver.ts';

/** One session the fake opened, and what happened to it. */
export class FakeSession implements LiveSession {
  readonly open: DriverOpen;
  readonly sent: string[] = [];
  readonly modes: ClaudePermissionMode[] = [];
  interrupts = 0;
  closed = false;
  readonly #listener: SessionListener;
  readonly #aborts = new Set<AbortController>();

  constructor(open: DriverOpen, listener: SessionListener) {
    this.open = open;
    this.#listener = listener;
  }

  send(text: string): void { this.sent.push(text); }

  interrupt(): Promise<void> {
    this.interrupts += 1;
    // as Claude does: what the turn waited on is withdrawn
    for (const abort of this.#aborts) { abort.abort(); }
    return Promise.resolve();
  }

  setMode(mode: ClaudePermissionMode): Promise<void> {
    this.modes.push(mode);
    return Promise.resolve();
  }

  close(): void { this.closed = true; }

  /** Report something, as Claude would. */
  emit(event: DriverEvent): void { this.#listener.event(event); }

  /** Ask for a tool use, as Claude's `canUseTool` would. */
  permit(request: PermitRequest): Promise<PermitDecision> {
    return this.#asking((signal) => this.#listener.permit(request, signal));
  }

  /** Ask a question, as `AskUserQuestion` or an elicitation would. */
  question(request: QuestionRequest): Promise<QuestionReply> {
    return this.#asking((signal) => this.#listener.question(request, signal));
  }

  async #asking<T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    this.#aborts.add(abort);
    try {
      return await ask(abort.signal);
    } finally {
      this.#aborts.delete(abort);
    }
  }
}

/** The scripted driver. */
export class FakeClaudeDriver implements ClaudeDriver {
  readonly opened: FakeSession[] = [];
  /** Claude's store, newest first. */
  readonly stored: StoredSession[] = [];
  /** Transcripts by session (or `session/agent`). */
  readonly transcripts = new Map<string, ClaudeTranscriptItem[]>();
  /** What `importables` finds in every folder. */
  found: FoundImportable[] = [];
  /** Skill texts by name. */
  readonly skills = new Map<string, string>();

  /** The last session opened with this id. */
  live(session: ClaudeSessionId): FakeSession {
    const found = this.opened.findLast((s) => s.open.session === session);
    if (found === undefined) { throw new Error(`no session ${session} was opened`); }
    return found;
  }

  open(open: DriverOpen, listener: SessionListener): LiveSession {
    const session = new FakeSession(open, listener);
    this.opened.push(session);
    return session;
  }

  sessions(query: { readonly folder?: string | undefined; readonly offset: number; readonly limit: number }): Promise<DriverPage<StoredSession>> {
    const all = this.stored.filter((s) => query.folder === undefined || s.folder === query.folder);
    return Promise.resolve({ items: all.slice(query.offset, query.offset + query.limit), more: all.length > query.offset + query.limit });
  }

  session(session: ClaudeSessionId): Promise<StoredSession | undefined> {
    return Promise.resolve(this.stored.find((s) => s.session === session));
  }

  transcript(query: { readonly session: ClaudeSessionId; readonly agent?: string | undefined; readonly offset: number; readonly limit: number }): Promise<DriverPage<ClaudeTranscriptItem>> {
    const all = this.transcripts.get(query.agent === undefined ? query.session : `${query.session}/${query.agent}`) ?? [];
    return Promise.resolve({ items: all.slice(query.offset, query.offset + query.limit), more: all.length > query.offset + query.limit });
  }

  importables(): Promise<FoundImportable[]> {
    return Promise.resolve(this.found);
  }

  skillText(name: string): Promise<string | undefined> {
    return Promise.resolve(this.skills.get(name));
  }
}
