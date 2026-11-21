/**
 * The claude system's implementation: one instance per machine. Live sessions are the fleet's (`fleet.ts`), over a
 * `ClaudeDriver`; each is mirrored as its person's `claude/Session` record (made in the run that starts or resumes it,
 * as that person; kept current by the fleet as the system). Who may touch a session is the hub's answer: a person finds
 * only their own records (an admin, every one), so every session fn first finds the record. Approved `permit` and
 * `answer` runs settle what the fleet waits on; a declined one arrives as a `run` event. Imported skills are kept as
 * `claude/Skill` records and declared as context again on every start.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  jsonOf, KindDescription, MCP_SYSTEM, qualify, type ApprovalPreview, type McpServerConfig, type ContextDecl, type ImportReport, type InputProblem, type Json, type ProposedRun,
  type RunInfo, type UserInfo,
} from '@harness/core';
import { CallFailed, canonicalJson, ginAs, wireType, type Data, type ProposeOptions, type StoredRecord, type SystemCtx, type SystemImpl } from '@harness/sdk';
import type { SystemPatch } from '@harness/sdk/server';
import {
  AGENT_KIND, AgentArgs, AgentPayload, ClaudeAllowMode, ClaudeAnswer, ClaudeControl, asksPerson, type ClaudePermissionMode, type ModeAsked, ClaudeImport, ClaudeInstanceConfig, ClaudePermit, ClaudeSend, ClaudeSession, ClaudeStart, ClaudeTranscriptQuery, ClaudeTurn, DiskSessionsQuery,
  ImportablesQuery, claude, type ClaudeContract, type ClaudeImportable, type ClaudeMcpServerSummary, type ClaudeSessionId, type ImportOutcome,
} from '../shared/index.ts';
import type { ClaudeDriver, DriverOpen, FoundImportable } from './driver.ts';
import type { ClaudeSettings } from './env.ts';
import { NOT_WAITING, SessionFleet, oneLine, type FleetHub } from './fleet.ts';
import { mcpServerLines, modePreview } from './preview.ts';

/** What the impl needs of the running system: declaring imported skills as context. */
export interface ClaudeRuntime {
  patch(change: SystemPatch): Promise<ImportReport>;
}

/** The impl's parts. */
export interface ClaudeDeps {
  readonly settings: ClaudeSettings;
  readonly driver: ClaudeDriver;
  /** The running system, once serving (absent in tests that don't import skills). */
  readonly runtime?: () => Promise<ClaudeRuntime>;
  readonly now?: () => number;
}


/** A request's outcome, before it becomes the run's. */
type Done<T> = { readonly done: T } | { readonly invalid: InputProblem[] } | { readonly failed: string };

/** What starting a session needs of a run (a fn's or a kind's). */
interface RunSide {
  readonly run: RunInfo;
  readonly data: Data;
  readonly signal: AbortSignal;
  readonly config: unknown;
  progress(line: string, count: number): void;
  /** Proposing a run for the person (a mode that lets Claude do more on its own). */
  propose(fn: string, args: Json, options: ProposeOptions): Promise<ProposedRun>;
}

/** A fraction that grows with each line and never reaches the end (a turn's length is unknown). */
const fractionOf = (count: number): number => 1 - 1 / (1 + count / 8);

/**
 * Where a path really is: its deepest existing folder with links followed, plus the part that doesn't exist yet.
 * `undefined` for a link that leads nowhere (where it leads could change after the check).
 */
function reallyAt(path: string): string | undefined {
  const missing: string[] = [];
  let at = resolve(path);
  while (!existsSync(at)) {
    try { lstatSync(at); return undefined; } catch { /* nothing there: look one folder up */ }
    const up = dirname(at);
    if (up === at) { return resolve(path); }
    missing.unshift(basename(at));
    at = up;
  }
  return join(realpathSync.native(at), ...missing);
}

/**
 * The folder a request names, where it really is (links followed), when that is under where one of the configured
 * folders really is: a link inside a configured folder can't lead a session out of it.
 */
export function allowedFolder(folder: string, config: ClaudeInstanceConfig): string | undefined {
  const wanted = reallyAt(folder);
  if (wanted === undefined) { return undefined; }
  return config.folders.some((root) => {
    const real = reallyAt(root.path);
    if (real === undefined) { return false; }
    const rel = relative(real, wanted);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }) ? wanted : undefined;
}

/** The statuses of a session with a live handle, which a restart leaves without one. */
const BUSY_STATUSES = ['starting', 'working', 'waiting'] as const;

/** A skill's context entry: its instructions, offered by `/name`. */
export function skillContext(skill: { readonly name: string; readonly description: string; readonly content: string }): ContextDecl {
  return {
    name: localNameOf('skill', skill.name), title: `Claude skill: ${skill.name}`, description: skill.description || `The ${skill.name} skill from Claude Code.`,
    content: skill.content, command: { name: skill.name, args: [] },
    imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: ['claude', 'skill'],
  };
}

/** A harness local name for an imported thing (`skill_release_notes`, `agent_code_reviewer`). */
export function localNameOf(prefix: string, name: string): string {
  return `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/** An `mcp` instance name for an MCP server Claude has (`Linear Issues` → `linear-issues`). */
export function instanceNameOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `mcp-${slug || 'server'}`;
}

/** The impl, the fleet, and closing every live session. */
export function createClaudeImpl(deps: ClaudeDeps): { readonly impl: SystemImpl<ClaudeContract['defs']>; readonly fleet: SessionFleet; close(): Promise<void> } {
  const settings = deps.settings;
  const instance = settings.HARNESS_INSTANCE;
  // signs what an import card's MCP server is in full (env values and headers too, which the card never shows), so a
  // change to any of it after the approval is caught; new each start, so a card from before a restart asks again
  const cardKey = randomBytes(32);
  const now = deps.now ?? (() => Date.now());
  let system: SystemCtx | undefined;

  const hub: FleetHub = {
    async saveSession(id, value) {
      if (system === undefined) { return; }
      await system.data.save(claude.types.Session, value, { id });
    },
    async propose(proposal) {
      if (system === undefined) { throw new Error('not connected to the hub'); }
      const options: ProposeOptions = { preview: proposal.preview, key: proposal.key, approver: 'person', for: proposal.for, ...(proposal.chat === undefined ? {} : { chat: proposal.chat }), ...(proposal.ask === undefined ? {} : { ask: proposal.ask }) };
      return (await system.propose(proposal.fn, proposal.args, options)).run;
    },
  };
  const fleet = new SessionFleet(deps.driver, () => (system === undefined ? undefined : hub), {
    instance, debounce: settings.CLAUDE_RECORD_DEBOUNCE, lastTextMax: settings.CLAUDE_LAST_TEXT_MAX, previewMax: settings.CLAUDE_PREVIEW_MAX, now,
    log: {
      debug: (key, fields) => { system?.log.debug(key, fields); },
      info: (key, fields) => { system?.log.info(key, fields); },
      warn: (key, fields) => { system?.log.warn(key, fields); },
      error: (key, fields, error) => { system?.log.error(key, fields, error); },
    },
  });

  const configOf = (value: unknown): ClaudeInstanceConfig | undefined => {
    const parsed = ClaudeInstanceConfig.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };

  /** The session record the run's person may see, newest version. */
  async function recordOf(data: Data, session: ClaudeSessionId): Promise<StoredRecord<ClaudeSession> | undefined> {
    const page = await data.find(claude.types.Session, { query: { filters: [{ field: 'session', op: 'is', value: session }, { field: 'instance', op: 'is', value: instance }], limit: 1 } });
    const found = page.items[0];
    return found === undefined ? undefined : { ...found, value: ClaudeSession.parse(found.value) };
  }

  /** A request for another machine's session is the caller's mistake. */
  const elsewhere = (other: string): InputProblem[] => [{ path: 'instance', message: `This is the claude instance "${instance}"; session calls for "${other}" go to that instance (call with on: "${other}").` }];

  /** The open request of a session the fleet makes live. */
  function openOf(value: ClaudeSession, resume: boolean, config: ClaudeInstanceConfig): DriverOpen {
    return { session: value.session, resume, folder: value.folder, model: value.model, permissionMode: value.permissionMode, agent: value.agent, hubMcp: hubMcpOf(value, config) };
  }

  /**
   * The hub MCP a session gets: the configured one, only when the session is its person's. The hub runs each call on it
   * as that person, so another person's session would call fns with their access and connections.
   */
  function hubMcpOf(value: ClaudeSession, config: ClaudeInstanceConfig): DriverOpen['hubMcp'] {
    const mcp = config.hubMcp;
    if (mcp === undefined) { return undefined; }
    if (mcp.person !== value.owner) {
      system?.log.info('claude.hub_mcp_withheld', { session: value.session, reason: mcp.person === undefined ? 'no person set on the hub MCP' : 'the session is another person\'s' });
      return undefined;
    }
    return { url: mcp.url, secret: mcp.secret };
  }

  /** Wait for the turn when asked; else the session as it is now. */
  async function turnOf(session: ClaudeSessionId, wait: boolean, side: Pick<RunSide, 'signal' | 'progress'>): Promise<Done<ClaudeTurn>> {
    if (!wait) { return { done: { instance, session, status: fleet.value(session)?.status ?? 'closed' } }; }
    let lines = 0;
    const end = await fleet.turn(session, (line) => { lines += 1; side.progress(line, lines); }, side.signal);
    if ('ended' in end) { return end.problem === undefined ? { done: { instance, session, status: 'closed' } } : { failed: `The session ended: ${end.problem}` }; }
    const status = fleet.value(session)?.status ?? 'closed';
    return end.ok ? { done: { instance, session, status, text: end.text, costUsd: end.costUsd } } : { failed: end.text === '' ? 'The turn failed.' : end.text };
  }

  /**
   * Ask the session's person to let it work in `mode`, one that lets Claude do more on its own: a proposed
   * `allow_mode` run, every time (its approvals are never remembered), with the mode on its card.
   */
  async function askMode(value: ClaudeSession, mode: ClaudePermissionMode, side: Pick<RunSide, 'propose'>): Promise<ModeAsked> {
    const args: ClaudeAllowMode = { instance, session: value.session, mode };
    const proposed = await side.propose('allow_mode', jsonOf(args), { preview: modePreview(mode, value), approver: 'person' });
    return { run: proposed.run, mode, says: `Working in ${mode} mode waits for the person to approve it. Tell them and end your turn; until then the session stays in ${value.permissionMode} mode.` };
  }

  /** Switch a session's mode: a live one now, a closed one when it is next resumed (`send` opens it with its record's). */
  async function switchMode(record: StoredRecord<ClaudeSession>, mode: ClaudePermissionMode, data: Data): Promise<void> {
    if (fleet.isLive(record.value.session)) { await fleet.setMode(record.value.session, mode); return; }
    await data.save(claude.types.Session, { ...record.value, permissionMode: mode }, { id: record.id });
  }

  /** Start a session for the run's person (`start_session` and the `agent` kind). */
  async function start(args: ClaudeStart, side: RunSide): Promise<Done<ClaudeTurn>> {
    const config = configOf(side.config);
    if (config === undefined) { return { failed: 'This claude instance has no folders configured yet: an admin sets them on the system\'s page.' }; }
    const folder = allowedFolder(args.folder, config);
    if (folder === undefined) { return { invalid: [{ path: 'folder', message: `Not under a configured folder (${config.folders.map((f) => f.path).join(', ')}).` }] }; }
    if (fleet.size >= config.maxLive) { return { failed: `${String(config.maxLive)} sessions are live on this machine, the most it runs at once: stop one first.` }; }
    const at = now();
    // a mode the run asks for that lets Claude do more on its own waits for the person; the session starts careful
    const asked = args.permissionMode !== undefined && asksPerson(args.permissionMode) ? args.permissionMode : undefined;
    const permissionMode = asked === undefined ? args.permissionMode ?? config.permissionMode : asksPerson(config.permissionMode) ? 'default' : config.permissionMode;
    const value: ClaudeSession = {
      instance, session: randomUUID(), folder, title: args.title ?? oneLine(args.prompt, 80), status: 'starting', owner: side.run.user.id,
      ...(side.run.session === undefined ? {} : { chat: side.run.session }),
      ...((args.model ?? config.model) === undefined ? {} : { model: args.model ?? config.model }),
      permissionMode, ...(args.agent === undefined ? {} : { agent: args.agent }),
      waiting: [], asking: [], tasks: [], turns: 0, costUsd: 0, startedAt: at, updatedAt: at,
    };
    const saved = await side.data.save(claude.types.Session, value);
    fleet.open(saved.id, value, openOf(value, false, config), args.prompt, config.idleClose);
    const modeAsked = asked === undefined ? undefined : await askMode(value, asked, side);
    const turn = await turnOf(value.session, args.wait, side);
    return modeAsked !== undefined && 'done' in turn ? { done: { ...turn.done, modeAsked } } : turn;
  }

  /** Send to a session, resuming it first when it isn't live. */
  async function send(args: ClaudeSend, side: RunSide): Promise<Done<ClaudeTurn>> {
    if (args.instance !== instance) { return { invalid: elsewhere(args.instance) }; }
    const config = configOf(side.config);
    if (config === undefined) { return { failed: 'This claude instance is not configured yet.' }; }
    const record = await recordOf(side.data, args.session) ?? await adopt(args.session, side, config);
    if (record === undefined) { return { invalid: [{ path: 'session', message: 'No such session of yours on this machine.' }] }; }
    // what Claude asks is proposed to the session's person, so only they talk to it (an admin may read, stop or interrupt it)
    if (record.value.owner !== side.run.user.id) { return { invalid: [{ path: 'session', message: "This session is another person's: only they can send to it or resume it. You can read its transcript, interrupt it or stop it." }] }; }
    if (!fleet.send(args.session, args.text)) {
      if (fleet.size >= config.maxLive) { return { failed: `${String(config.maxLive)} sessions are live on this machine, the most it runs at once: stop one first.` }; }
      const value: ClaudeSession = { ...record.value, ...(side.run.session === undefined ? {} : { chat: side.run.session }), waiting: [], asking: [] };
      fleet.open(record.id, value, openOf(value, true, config), args.text, config.idleClose);
    }
    return turnOf(args.session, args.wait, side);
  }

  /** A session in Claude's store that has no record yet becomes an admin's (resuming it), else `undefined`. */
  async function adopt(session: ClaudeSessionId, side: RunSide, config: ClaudeInstanceConfig): Promise<StoredRecord<ClaudeSession> | undefined> {
    if (!isAdmin(side.run.user)) { return undefined; }
    const stored = await deps.driver.session(session);
    const folder = stored?.folder === undefined ? undefined : allowedFolder(stored.folder, config);
    if (stored === undefined || folder === undefined) { return undefined; }
    const at = now();
    const value: ClaudeSession = {
      instance, session, folder, title: stored.title, status: 'closed', owner: side.run.user.id, permissionMode: config.permissionMode,
      waiting: [], asking: [], tasks: [], turns: 0, costUsd: 0, startedAt: stored.updatedAt, updatedAt: at,
    };
    const saved = await side.data.save(claude.types.Session, value);
    return { ...saved, value };
  }

  /** What is imported already, by kind and name. */
  async function importedOf(items: readonly FoundImportable[], ctx: { readonly data: Data; searchFns: SystemCtx['searchFns'] }, mcpInstances: () => Promise<ReadonlySet<string>>): Promise<ClaudeImportable[]> {
    const skills = await ctx.data.find(claude.types.Skill, { query: { filters: [{ field: 'instance', op: 'is', value: instance }], limit: 100 } });
    const skillNames = new Set(skills.items.map((record) => record.value.name));
    const agents = await ctx.searchFns({ kinds: [AGENT_KIND], instance, limit: 100 });
    const agentNames = new Set(agents.items.map((hit) => hit.name));
    const servers = items.some((item) => item.kind === 'mcp-server') ? await mcpInstances() : new Set<string>();
    return items.map((item): ClaudeImportable => {
      switch (item.kind) {
        case 'skill': return { ...item, imported: skillNames.has(item.name) };
        case 'agent': return { ...item, imported: agentNames.has(qualify(claude.name, localNameOf('agent', item.name))) };
        case 'mcp-server': { const { server, ...rest } = item; return { ...rest, server: summaryOf(server), imported: servers.has(instanceNameOf(item.name)) }; }
      }
    });
  }

  /** Declare the imported skills of this instance as context again (a page of records at a time). */
  async function declareSkills(ctx: SystemCtx): Promise<void> {
    if (deps.runtime === undefined) { return; }
    const runtime = await deps.runtime();
    let cursor: string | undefined;
    do {
      const page = await ctx.data.find(claude.types.Skill, { query: { filters: [{ field: 'instance', op: 'is', value: instance }], limit: 50, ...(cursor === undefined ? {} : { cursor }) } });
      if (page.items.length > 0) { await runtime.patch({ upsert: { context: page.items.map((record) => skillContext(record.value)) } }); }
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  /**
   * After a restart, a session this instance's records show as busy has no live handle: its waiting requests are gone
   * and its runs fail plainly, so its record says it is closed (it stays resumable). A page of records at a time.
   */
  async function sweepSessions(ctx: SystemCtx): Promise<void> {
    for (const status of BUSY_STATUSES) {
      let cursor: string | undefined;
      do {
        const page = await ctx.data.find(claude.types.Session, { query: { filters: [{ field: 'instance', op: 'is', value: instance }, { field: 'status', op: 'is', value: status }], limit: 50, ...(cursor === undefined ? {} : { cursor }) } });
        for (const record of page.items) {
          const value = ClaudeSession.parse(record.value);
          if (fleet.value(value.session) !== undefined) { continue; }
          await ctx.data.save(claude.types.Session, { ...value, status: 'closed', waiting: [], asking: [], updatedAt: now() }, { id: record.id });
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
    }
  }

  const impl: SystemImpl<ClaudeContract['defs']> = {
    lifecycle: {
      started: async (ctx) => {
        system = ctx;
        await declareSkills(ctx).catch((error: unknown) => { ctx.log.warn('claude.skills_failed', { problem: String(error) }); });
        await sweepSessions(ctx).catch((error: unknown) => { ctx.log.warn('claude.sweep_failed', { problem: String(error) }); });
      },
      configured: (ctx) => { system = ctx; return Promise.resolve(); },
      stopping: async () => { await fleet.stopAll(); },
    },
    events: {
      run: (event, ctx) => {
        system = ctx;
        const proposed = event.fn === qualify(claude.name, 'permit') || event.fn === qualify(claude.name, 'answer');
        if (proposed && event.update.type === 'status' && event.update.status === 'cancelled') {
          // the hub's words say who declined and why
          fleet.declined(event.run, event.update.text?.one ?? 'The person declined.');
        }
        return Promise.resolve();
      },
    },
    kinds: {
      agent: {
        check: (payload) => Promise.resolve(AgentPayload.safeParse(payload).success ? [] : ['not an agent payload']),
        describe: (payload) => {
          const agent = AgentPayload.parse(payload);
          return Promise.resolve(KindDescription.parse({
            args: wireType(ginAs(AgentArgs)), returns: wireType(ginAs(ClaudeTurn)), deps: [],
            operations: { cancel: true, pause: false, undo: false, background: true }, progress: { type: 'linear' }, display: 'card', effects: { mode: 'write' },
            // a task in the agent's own words, in its own folder
            examples: [{ args: { prompt: agent.description === '' ? `Do what the ${agent.agent} agent is for.` : agent.description }, note: `A task for Claude's ${agent.agent} agent, in ${agent.folder}.` }],
          }));
        },
        async run(payload, args, ctx) {
          const agent = AgentPayload.parse(payload);
          const given = AgentArgs.safeParse(args);
          if (!given.success) { return ctx.invalid(given.error.message); }
          if (agent.instance !== instance) { return ctx.invalid(elsewhere(agent.instance)); }
          const outcome = await start(ClaudeStart.parse({ folder: given.data.folder ?? agent.folder, prompt: given.data.prompt, agent: agent.agent, wait: given.data.wait }), {
            run: ctx.run, data: ctx.data, signal: ctx.signal, config: ctx.config,
            progress: (line, count) => { ctx.progress({ fraction: fractionOf(count), message: line }); },
            propose: (fn, proposed, options) => ctx.propose(fn, proposed, options),
          });
          return 'done' in outcome ? ctx.done(jsonOf(outcome.done)) : 'invalid' in outcome ? ctx.invalid(outcome.invalid) : ctx.fail('caller', outcome.failed);
        },
      },
    },
    fns: {
      folders: {
        run(_args, ctx) {
          const config = configOf(ctx.config);
          if (config === undefined) { return Promise.resolve(ctx.fail('caller', 'This claude instance is not configured yet.')); }
          return Promise.resolve(ctx.done({ instance, folders: config.folders.map((folder) => ({ ...folder })) }));
        },
      },
      start_session: {
        async run(args, ctx) {
          const outcome = await start(ClaudeStart.parse(args), { ...ctx, progress: (line, count) => { ctx.progress.set(fractionOf(count), line); } });
          return 'done' in outcome ? ctx.done(outcome.done) : 'invalid' in outcome ? ctx.invalid(outcome.invalid) : ctx.fail('caller', outcome.failed);
        },
      },
      send: {
        async run(args, ctx) {
          const outcome = await send(ClaudeSend.parse(args), { ...ctx, progress: (line, count) => { ctx.progress.set(fractionOf(count), line); } });
          return 'done' in outcome ? ctx.done(outcome.done) : 'invalid' in outcome ? ctx.invalid(outcome.invalid) : ctx.fail('caller', outcome.failed);
        },
      },
      control: {
        async run(raw, ctx) {
          const args = ClaudeControl.parse(raw);
          if (args.instance !== instance) { return ctx.invalid(elsewhere(args.instance)); }
          const record = await recordOf(ctx.data, args.session);
          if (record === undefined) { return ctx.invalid([{ path: 'session', message: 'No such session of yours on this machine.' }]); }
          if (args.action === 'mode' && args.mode === undefined) { return ctx.invalid([{ path: 'mode', message: 'Give the permission mode to switch to.' }]); }
          // the mode decides what Claude may do without asking its person, so only they change it (an admin may interrupt or stop)
          if (args.mode !== undefined && record.value.owner !== ctx.run.user.id) { return ctx.invalid([{ path: 'mode', message: "This session is another person's: only they can change what it may do without asking. You can interrupt it or stop it." }]); }
          if (!fleet.isLive(args.session) && args.action !== 'mode') { return ctx.invalid([{ path: 'session', message: `The session is not live, so there is nothing to ${args.action}.` }]); }
          // a mode that lets Claude do more on its own is the person's to approve, every time; any other switches now
          const asked = args.mode !== undefined && asksPerson(args.mode) ? args.mode : undefined;
          if (args.mode !== undefined && asked === undefined) { await switchMode(record, args.mode, ctx.data); }
          if (args.action === 'interrupt') { await fleet.interrupt(args.session); } else if (args.action === 'stop') { fleet.stop(args.session); }
          const status = fleet.value(args.session)?.status ?? 'closed';
          const modeAsked = asked === undefined ? undefined : await askMode(fleet.value(args.session) ?? record.value, asked, ctx);
          return ctx.done({ instance, session: args.session, status, ...(modeAsked === undefined ? {} : { modeAsked }) });
        },
      },
      allow_mode: {
        async run(raw, ctx) {
          const args = ClaudeAllowMode.parse(raw);
          if (args.instance !== instance) { return ctx.invalid(elsewhere(args.instance)); }
          const record = await recordOf(ctx.data, args.session);
          // the run is the session's person's (the approver of the proposal): only they let it do more on its own
          if (record === undefined || record.value.owner !== ctx.run.user.id) { return ctx.invalid([{ path: 'session', message: 'No such session of yours on this machine.' }]); }
          if (ctx.approved === undefined) { return ctx.fail('caller', 'This mode needs the person to approve it first.'); }
          await switchMode(record, args.mode, ctx.data);
          return ctx.done({ instance, session: args.session, status: fleet.value(args.session)?.status ?? 'closed' });
        },
        preview(raw) {
          const args = ClaudeAllowMode.parse(raw);
          return Promise.resolve({ preview: modePreview(args.mode, fleet.value(args.session)) });
        },
      },
      transcript: {
        async run(raw, ctx) {
          const args = ClaudeTranscriptQuery.parse(raw);
          if (args.instance !== instance) { return ctx.invalid(elsewhere(args.instance)); }
          const record = await recordOf(ctx.data, args.session);
          if (record === undefined && !isAdmin(ctx.run.user)) { return ctx.invalid([{ path: 'session', message: 'No such session of yours on this machine.' }]); }
          const page = await deps.driver.transcript({ session: args.session, folder: record?.value.folder, agent: args.agent, offset: args.offset, limit: args.limit, fromEnd: args.fromEnd });
          return ctx.done({ items: [...page.items], offset: page.offset, end: page.end, ...(page.more ? { next: page.end } : {}) });
        },
      },
      disk_sessions: {
        async run(raw, ctx) {
          const args = DiskSessionsQuery.parse(raw);
          if (!isAdmin(ctx.run.user)) { return ctx.fail('caller', 'Only an admin may list every session on the machine; your own are your claude/Session records.'); }
          const config = configOf(ctx.config);
          const folder = args.folder === undefined || config === undefined ? undefined : allowedFolder(args.folder, config);
          if (args.folder !== undefined && folder === undefined) { return ctx.invalid([{ path: 'folder', message: 'Not under a configured folder.' }]); }
          const page = await deps.driver.sessions({ folder, offset: args.offset, limit: args.limit });
          return ctx.done({
            items: page.items.map((s) => ({ session: s.session, ...(s.folder === undefined ? {} : { folder: s.folder }), title: s.title, updatedAt: s.updatedAt, ...(s.branch === undefined ? {} : { branch: s.branch }), live: fleet.isLive(s.session) })),
            ...(page.more ? { next: args.offset + args.limit } : {}),
          });
        },
      },
      permit: {
        async run(raw, ctx) {
          const args = ClaudePermit.parse(raw);
          // the run is the session's person's (the approver of the proposal): only they settle its requests
          if (args.instance !== instance || await recordOf(ctx.data, args.session) === undefined) { return ctx.fail('caller', NOT_WAITING); }
          return fleet.permit(args.session, args.request, ctx.run.id, args.always)
            ? ctx.done({ instance, session: args.session, request: args.request, allowed: true, always: args.always })
            : ctx.fail('caller', NOT_WAITING);
        },
      },
      answer: {
        async run(raw, ctx) {
          const args = ClaudeAnswer.parse(raw);
          if (args.instance !== instance || await recordOf(ctx.data, args.session) === undefined) { return ctx.fail('caller', NOT_WAITING); }
          return fleet.answer(args.session, args.request, ctx.run.id, args.answer)
            ? ctx.done({ instance, session: args.session, request: args.request, answered: true })
            : ctx.fail('caller', NOT_WAITING);
        },
      },
      importables: {
        async run(raw, ctx) {
          const args = ImportablesQuery.parse(raw);
          const config = configOf(ctx.config);
          const folder = config === undefined ? undefined : allowedFolder(args.folder, config);
          if (folder === undefined) { return ctx.invalid([{ path: 'folder', message: 'Not under a configured folder.' }]); }
          const mcpInstances = async (): Promise<ReadonlySet<string>> => {
            try {
              return new Set((await ctx.fns.system({ system: MCP_SYSTEM })).instances.map((found) => found.instance));
            } catch (error) {
              // the mcp system is not installed (or not visible): none of Claude's MCP servers counts as imported
              if (error instanceof CallFailed && error.error.class !== 'cancelled') { ctx.log.info('claude.mcp_instances_unknown', { problem: error.error.message }); return new Set(); }
              throw error;
            }
          };
          return ctx.done({ folder, items: await importedOf(await deps.driver.importables(folder), ctx, mcpInstances) });
        },
      },
      import: {
        async run(raw, ctx) {
          const args = ClaudeImport.parse(raw);
          const config = configOf(ctx.config);
          if (config === undefined) { return ctx.fail('caller', 'This claude instance is not configured yet.'); }
          // what runs is what the admin's card showed: an MCP server whose command changed since is not imported
          if (ctx.approved === undefined) { return ctx.fail('caller', 'An import needs an admin to approve it first.'); }
          if (canonicalJson(jsonOf(await importPreview(args, config))) !== canonicalJson(jsonOf(ctx.approved.preview))) { return ctx.fail('caller', 'What Claude has changed since the import was approved: ask again.'); }
          const outcome: ImportOutcome = { imported: [], refused: [] };
          const skills: ContextDecl[] = [];
          for (const item of args.items) {
            const target = await importTarget(item, config);
            const refuse = (why: string) => { outcome.refused.push({ kind: item.kind, name: item.name, why }); };
            if ('why' in target) { refuse(target.why); continue; }
            const { folder, thing } = target;
            switch (thing.kind) {
              case 'skill': {
                const content = await deps.driver.skillText(thing.name, folder);
                if (content === undefined) { refuse('It has no SKILL.md the harness can read (a plugin\'s skill).'); break; }
                const skill = { instance, name: thing.name, description: thing.description, content, ...(thing.scope === 'project' ? { folder } : {}) };
                const existing = await ctx.data.find(claude.types.Skill, { query: { filters: [{ field: 'instance', op: 'is', value: instance }, { field: 'name', op: 'is', value: thing.name }], limit: 1 } });
                await ctx.data.save(claude.types.Skill, skill, existing.items[0] === undefined ? {} : { id: existing.items[0].id });
                skills.push(skillContext(skill));
                outcome.imported.push({ kind: 'skill', name: thing.name, as: qualify(claude.name, localNameOf('skill', thing.name)) });
                break;
              }
              case 'agent': {
                const name = localNameOf('agent', thing.name);
                const payload: AgentPayload = { instance, agent: thing.name, folder, description: thing.description };
                await ctx.fns.saveFn({ kind: AGENT_KIND, name, description: thing.description || `Claude's ${thing.name} agent.`, payload: jsonOf(payload), tags: ['claude', 'agent'], routing: { to: 'instance', instance }, replace: true });
                outcome.imported.push({ kind: 'agent', name: thing.name, as: qualify(claude.name, name) });
                break;
              }
              case 'mcp-server': {
                const name = instanceNameOf(thing.name);
                try {
                  await ctx.fns.addInstance({ system: MCP_SYSTEM, instance: name, description: thing.description, config: jsonOf(thing.server) });
                  outcome.imported.push({ kind: 'mcp-server', name: thing.name, as: `${MCP_SYSTEM} instance ${name}` });
                } catch (error) {
                  refuse(error instanceof CallFailed && error.error.class !== 'cancelled' ? error.error.message : String(error));
                }
                break;
              }
            }
          }
          if (skills.length > 0 && deps.runtime !== undefined) { await (await deps.runtime()).patch({ upsert: { context: skills } }); }
          return ctx.done(outcome);
        },
        async preview(raw, ctx) {
          const config = configOf(ctx.config);
          if (config === undefined) { return { refused: 'This claude instance is not configured yet.' }; }
          return { preview: await importPreview(ClaudeImport.parse(raw), config) };
        },
      },
    },
  };

  /** What an import item names, as Claude sees it now, or why it can't be imported. */
  async function importTarget(item: ClaudeImport['items'][number], config: ClaudeInstanceConfig): Promise<{ readonly folder: string; readonly thing: FoundImportable } | { readonly why: string }> {
    const folder = allowedFolder(item.folder ?? config.folders[0]?.path ?? '.', config);
    if (folder === undefined) { return { why: 'Its folder is not under a configured folder.' }; }
    const thing = (await deps.driver.importables(folder)).find((f) => f.kind === item.kind && f.name === item.name);
    return thing === undefined ? { why: `Claude does not see this ${item.kind} in ${folder}.` } : { folder, thing };
  }

  /** The admin's card for an import: each item and where it is from; an MCP server's command, args, folder and env names. */
  async function importPreview(args: ClaudeImport, config: ClaudeInstanceConfig): Promise<ApprovalPreview> {
    const parts = await Promise.all(args.items.map(async (item): Promise<ApprovalPreview['parts'][number]> => {
      const target = await importTarget(item, config);
      if ('why' in target) { return { type: 'text', text: `${item.kind} ${item.name}: not imported. ${target.why}` }; }
      const { thing, folder } = target;
      if (thing.kind !== 'mcp-server') { return { type: 'text', text: `${thing.kind} ${thing.name} (${thing.scope}, ${folder})` }; }
      const check = createHmac('sha256', cardKey).update(canonicalJson(jsonOf(thing.server))).digest('hex').slice(0, 12);
      return { type: 'code', language: 'text', title: `MCP server ${thing.name} (${thing.scope}, ${folder})`, code: `${mcpServerLines(thing.server)}
check: ${check}` };
    }));
    return { title: `Import ${String(args.items.length)} from Claude`, parts, irreversible: false };
  }

  return { impl, fleet, close: () => fleet.stopAll() };
}

/** An MCP server's config as a list shows it: how it is reached and its secrets' names, never their values. */
export function summaryOf(server: McpServerConfig): ClaudeMcpServerSummary {
  const transport = server.transport;
  if (transport.type === 'stdio') { return { transport: 'stdio', where: transport.command, secrets: Object.keys(transport.env ?? {}) }; }
  const url = new URL(transport.url);
  const auth = server.auth;
  const secrets = auth.kind === 'headers' ? [...auth.names] : auth.kind === 'bearer' ? ['Authorization'] : [];
  return { transport: transport.type, where: `${url.origin}${url.pathname}`, secrets };
}

/** Whether a person is an admin. */
function isAdmin(user: UserInfo): boolean {
  return user.role === 'admin';
}

