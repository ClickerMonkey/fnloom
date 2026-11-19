/**
 * The claude system's own shapes (zod first; the contract reads them into gin with `ginAs`). The shared contracts a
 * web page or another system also reads (`ClaudeSession`, `ClaudeStart`, …) are in `session.ts`.
 */
import { InstanceName, Timestamp } from '@harness/core';
import { ClaudeFolder, ClaudeImportable, ClaudeSessionId, ClaudeSessionRef } from './session.ts';
import { z } from 'zod';

/** A page of Claude's own store (`claude/disk_sessions`): every session on the machine, live or not. */
export const DiskSessionsQuery = z.object({
  /** Only the sessions of this folder (a folder under one of the instance's `folders`); absent, every configured folder. */
  folder: z.string().min(1).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export type DiskSessionsQuery = z.infer<typeof DiskSessionsQuery>;

/** One session in Claude's store. */
export const DiskSession = z.object({
  session: ClaudeSessionId,
  /** Its working folder, when Claude recorded one. */
  folder: z.string().optional(),
  /** Its title: the name it was given, Claude's summary, or its first prompt. */
  title: z.string(),
  updatedAt: Timestamp,
  branch: z.string().optional(),
  /** Whether this instance has it live now. */
  live: z.boolean(),
});
export type DiskSession = z.infer<typeof DiskSession>;

/** A page of disk sessions, newest first; `next` is the offset of the following page, absent at the end. */
export const DiskSessionsPage = z.object({ items: z.array(DiskSession), next: z.number().int().min(0).optional() });
export type DiskSessionsPage = z.infer<typeof DiskSessionsPage>;

/** What `claude/folders` reads: nothing (the instance it runs on). */
export const FoldersQuery = z.object({});
export type FoldersQuery = z.infer<typeof FoldersQuery>;

/** The folders sessions may start in on this machine (and imports are read from): each session folder is under one. */
export const FoldersList = z.object({ instance: InstanceName, folders: z.array(ClaudeFolder) });
export type FoldersList = z.infer<typeof FoldersList>;

/** What `claude/importables` reads: the agents, skills and MCP servers Claude sees in one folder. */
export const ImportablesQuery = z.object({ folder: z.string().min(1) });
export type ImportablesQuery = z.infer<typeof ImportablesQuery>;

/** What Claude sees in a folder that can be imported. */
export const ImportablesList = z.object({ folder: z.string(), items: z.array(ClaudeImportable) });
export type ImportablesList = z.infer<typeof ImportablesList>;

/** What `claude/import` did with each item: what it became in the harness, or why not. */
export const ImportOutcome = z.object({
  imported: z.array(z.object({ kind: z.enum(['agent', 'skill', 'mcp-server']), name: z.string(), as: z.string() })),
  refused: z.array(z.object({ kind: z.enum(['agent', 'skill', 'mcp-server']), name: z.string(), why: z.string() })),
});
export type ImportOutcome = z.infer<typeof ImportOutcome>;

/** What an approved `claude/permit` answers. */
export const PermitOutcome = ClaudeSessionRef.extend({ request: z.string(), allowed: z.literal(true), always: z.boolean() });
export type PermitOutcome = z.infer<typeof PermitOutcome>;

/** What an answered `claude/answer` answers. */
export const AnswerOutcome = ClaudeSessionRef.extend({ request: z.string(), answered: z.literal(true) });
export type AnswerOutcome = z.infer<typeof AnswerOutcome>;

/** What `claude/control` answers: the session's status after it. */
export const ControlOutcome = ClaudeSessionRef.extend({ status: z.enum(['starting', 'working', 'waiting', 'idle', 'closed', 'failed']) });
export type ControlOutcome = z.infer<typeof ControlOutcome>;

/** The payload of a `claude/agent` fn: an imported Claude agent (a subagent definition) on one machine. */
export const AgentPayload = z.object({
  instance: InstanceName,
  /** The agent's name, as Claude knows it. */
  agent: z.string().min(1),
  /** The folder its sessions start in (where a project agent is defined). */
  folder: z.string().min(1),
  description: z.string(),
});
export type AgentPayload = z.infer<typeof AgentPayload>;

/** A `claude/agent` fn's args: the task for the agent. */
export const AgentArgs = z.object({
  prompt: z.string().min(1),
  /** Another folder to work in, under the instance's `folders`; absent, the agent's own. */
  folder: z.string().min(1).optional(),
  /** Wait for the agent's turn to finish (the default), or answer once its session is live. */
  wait: z.boolean().default(true),
});
export type AgentArgs = z.infer<typeof AgentArgs>;

/** An imported Claude skill, kept as a hub record (`claude/Skill`) so it is offered as context again after a restart. */
export const ImportedSkill = z.object({
  instance: InstanceName,
  name: z.string().min(1),
  description: z.string(),
  /** Where it was found: a project folder, or absent for the person's own (user) skills. */
  folder: z.string().optional(),
  /** The skill's instructions (its `SKILL.md` without the header). */
  content: z.string(),
});
export type ImportedSkill = z.infer<typeof ImportedSkill>;
