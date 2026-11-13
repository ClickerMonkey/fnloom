/**
 * The mock hub's build 9 state: MCP servers and API services as fleets of the bundled `mcp` and `api` systems (one of
 * each to start: a Linear server over HTTP with a per-person OAuth sign-in, and a GitHub API with a shared token kept
 * sealed), adding one (`addInstance`), each server's status (`readFn` of `mcp/server_status`), and the `mcp`
 * system's instance-scoped connect page. The Claude fleet: the person's `claude/Session` records on two machines (one
 * waiting on them, with a running workflow), and a session's transcript (`readFn` of `claude/transcript`).
 */
import {
  ClaudeSession, ClaudeTranscriptQuery, ConnectDecl, DataRecord, InstanceName, Json, McpServerStatus, SECRET_KEPT, type SystemName, type AddInstance, type ApprovalPreview, type ClaudeTranscriptItem,
  type ConnectPage, type InstanceRef, type InstanceView, type ProposalAsk, type ReadTableArgs, type RecordPage, type RecordQuery, type RunId, type SessionId,
} from '@harness/core';
import type { z } from 'zod';
import { CLAUDE_FNS, SESSION_TYPE } from '../src/claude/logic/claude.ts';
import { instanceView } from '../src/admin/test/build2.ts';
import { API } from '../src/admin/logic/api-services.ts';
import { MCP } from '../src/admin/logic/mcp-servers.ts';
import { SERVER_STATUS_FN } from '../src/admin/state/mcp-servers.ts';
import { fixture } from './fixture.ts';

const MCP_CONNECT = fixture(ConnectDecl, {
  title: 'MCP servers', description: 'Sign in to the MCP servers that need your own account.', icon: 'braces', how: { flow: 'oauth' },
  settings: { name: 'obj', props: {} }, fns: {}, scope: 'instance', defaults: { on: true, ask: false },
});

/** The Claude session that waits on the person. */
export const CLAUDE_WAITING = { instance: 'laptop', session: '0b6f3c1e-4a3e-4c55-9d5c-2f1e8a7b9c10' } as const;

/** The tool Claude waits to use, as its card shows it. */
export const PERMIT_PREVIEW: ApprovalPreview = {
  title: 'Claude wants to use Bash', irreversible: false,
  parts: [{ type: 'text', text: 'Run the checkout tests.' }, { type: 'code', language: 'bash', code: 'npm test -- checkout' }],
};

/** The question Claude asks, as the card's form. */
export const QUESTION_ASK: ProposalAsk = {
  type: { name: 'obj', props: { database: { type: { name: 'text' }, docs: 'Which database the checkout uses (shop or legacy).' } } }, into: 'answer',
};

const TRANSCRIPT: readonly ClaudeTranscriptItem[] = [
  { type: 'user', uuid: 'u1', text: 'The checkout test fails on CI. Find out why and fix it.' },
  { type: 'thinking', uuid: 'k1', text: 'Start with the failing test and the config it loads.' },
  { type: 'tool-use', uuid: 't1', id: 'tu1', tool: 'Bash', input: { command: 'npm test -- checkout', description: 'Run the checkout tests' } },
  { type: 'tool-result', uuid: 'r1', id: 'tu1', ok: false, text: 'FAIL src/checkout.test.ts\n  ✕ totals the cart (12 ms)\n    Expected 42.00, received 40.00' },
  { type: 'tool-use', uuid: 't2', id: 'tu2', tool: 'Read', input: { file_path: 'src/checkout/totals.ts' } },
  { type: 'tool-result', uuid: 'r2', id: 'tu2', ok: true, text: 'export function total(cart: Cart): number { … }' },
  { type: 'assistant', uuid: 'a1', text: 'The total skips the **delivery fee** when the cart has a coupon. Two configs set the fee; I need to know which database the checkout reads before I change it.' },
];

/** The MCP servers, API services and Claude sessions, in memory. */
export class MockBuild9 {
  readonly #now: () => number;
  readonly fleets = new Map<SystemName, InstanceView[]>();
  #claude: DataRecord[] = [];

  constructor(now: () => number) {
    this.#now = now;
    const at = now() - 3_600_000;
    this.fleets.set(MCP, [instanceView({
      system: MCP, instance: 'linear', description: 'Linear issues', version: '0.1.0', dirs: undefined,
      config: { value: { label: 'Linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp' }, auth: { kind: 'oauth', per: 'person' }, trusted: false, approval: 'writes', prompts: true, resources: true, maxTools: 200, timeout: 120_000 }, version: 1, setBy: 'act_ada', setAt: at },
    })]);
    this.fleets.set(API, [instanceView({
      system: API, instance: 'github', description: 'GitHub REST', version: '0.1.0', dirs: undefined,
      config: { value: { label: 'GitHub', baseUrl: 'https://api.github.com', auth: { kind: 'bearer', per: 'shared', token: SECRET_KEPT }, headers: { Accept: 'application/vnd.github+json' }, timeout: 60_000, maxBody: 2_000_000 }, version: 1, setBy: 'act_ada', setAt: at },
    })]);
  }

  /** Whether the mock keeps this system's fleet. */
  has(system: SystemName): boolean {
    return this.fleets.has(system);
  }

  instancesOf(system: SystemName): InstanceView[] {
    return this.fleets.get(system) ?? [];
  }

  add(input: AddInstance): InstanceRef {
    const at = this.#now();
    const view = instanceView({
      system: input.system, instance: input.instance, description: input.description ?? '', version: '0.1.0', dirs: undefined, status: 'connected',
      config: { value: input.config, version: 1, setBy: 'act_ada', setAt: at },
    });
    this.fleets.set(input.system, [...this.instancesOf(input.system), view]);
    return { system: input.system, instance: input.instance };
  }

  configure(system: SystemName, instance: InstanceName, config: Json): { version: number } {
    const list = this.instancesOf(system);
    const found = list.find((view) => view.instance === instance);
    const version = (found?.config?.version ?? 0) + 1;
    this.fleets.set(system, list.map((view) => (view.instance === instance ? { ...view, config: { value: config, version, setBy: 'act_ada', setAt: this.#now() } } : view)));
    return { version };
  }

  remove(ref: InstanceRef): { ok: boolean } {
    const list = this.instancesOf(ref.system);
    this.fleets.set(ref.system, list.filter((view) => view.instance !== ref.instance));
    return { ok: list.some((view) => view.instance === ref.instance) };
  }

  /** Seed the Claude fleet: the waiting session's cards are runs in its chat (`waiting`). */
  seedClaude(chat: SessionId, waiting: readonly RunId[]): void {
    const now = this.#now();
    const values: z.input<typeof ClaudeSession>[] = [
      {
        ...CLAUDE_WAITING, folder: 'C:/code/shop', title: 'Fix the checkout test', status: 'waiting', owner: 'act_ada', chat, permissionMode: 'default', waiting: [...waiting], asking: [],
        tasks: [
          { id: 'wf1', kind: 'workflow', name: 'release-check', description: 'Lint, test and build before the fix', status: 'running', progress: 'Step 2 of 3: tests (14/31 passed)', startedAt: now - 240_000, updatedAt: now - 20_000 },
          { id: 'ag1', kind: 'agent', name: 'Explore', description: 'Find where the delivery fee is set', status: 'done', parent: 'wf1', startedAt: now - 230_000, updatedAt: now - 200_000 },
          { id: 'sh1', kind: 'shell', description: 'npm run build -- --watch', status: 'running', progress: 'Rebuilt in 1.4 s', startedAt: now - 180_000, updatedAt: now - 30_000 },
        ],
        lastText: 'The total skips the delivery fee when the cart has a coupon.', model: 'claude-sonnet-4-5', turns: 3, costUsd: 0.42, startedAt: now - 300_000, updatedAt: now - 20_000,
      },
      {
        instance: 'laptop', session: '6a1d2e3f-0b4c-4d5e-8f6a-7b8c9d0e1f2a', folder: 'C:/code/harness', title: 'Tidy the router', status: 'working', owner: 'act_ada', permissionMode: 'acceptEdits',
        waiting: [], asking: [], tasks: [{ id: 'ag2', kind: 'agent', name: 'code-reviewer', description: 'Review the route table', status: 'running', startedAt: now - 60_000, updatedAt: now - 5_000 }],
        lastText: 'Moving the admin routes under one parent.', turns: 5, costUsd: 1.18, startedAt: now - 3_600_000, updatedAt: now - 90_000,
      },
      {
        instance: 'desktop', session: '9c8b7a6f-5e4d-4c3b-9a2f-1e0d9c8b7a6f', folder: 'D:/notes', title: 'Weekly notes summary', status: 'closed', owner: 'act_ada', permissionMode: 'plan',
        waiting: [], asking: [], tasks: [], lastText: 'Summed up 12 notes into three themes.', turns: 1, costUsd: 0.05, startedAt: now - 86_400_000, updatedAt: now - 82_000_000,
      },
    ];
    this.#claude = values.map((value, index) => DataRecord.parse({
      id: `rec_01JCLAUDE${String(index).padStart(17, '0')}`, type: SESSION_TYPE, value: Json.parse(ClaudeSession.parse(value)), owner: 'act_ada', title: value.title,
      version: 1, createdAt: value.startedAt, updatedAt: value.updatedAt,
    }));
  }

  /** A page of records of a type the mock keeps (the Claude sessions), or undefined for any other type. */
  records(query: RecordQuery): RecordPage | undefined {
    if (query.type !== SESSION_TYPE) { return undefined; }
    const filters = query.query?.filters ?? [];
    const words = query.search?.toLowerCase();
    const items = this.#claude.filter((record) => {
      const value = ClaudeSession.parse(record.value);
      const fields: Readonly<Record<string, string>> = { instance: value.instance, session: value.session, folder: value.folder, status: value.status };
      return filters.every((filter) => filter.op !== 'is' || fields[filter.field] === filter.value)
        && (words === undefined || [value.title, value.folder, value.lastText ?? ''].some((text) => text.toLowerCase().includes(words)));
    });
    return { items };
  }

  /** A read fn's answer: a server's status, a Claude transcript, or undefined for a fn the mock leaves to others. */
  read(input: ReadTableArgs): Json | undefined {
    if (input.fn === CLAUDE_FNS.transcript) {
      const query = ClaudeTranscriptQuery.parse(input.args);
      const items = query.agent === undefined ? TRANSCRIPT : TRANSCRIPT.slice(1, 3);
      return Json.parse({ items: items.slice(query.offset, query.offset + query.limit), offset: query.offset });
    }
    if (input.fn !== SERVER_STATUS_FN) { return undefined; }
    const instance = InstanceName.parse(input.args['instance']);
    const linear = instance === 'linear';
    return Json.parse(fixture(McpServerStatus, {
      instance, state: linear ? 'needs-auth' : 'connected', tools: linear ? 0 : 3, prompts: linear ? 0 : 1, resources: 0, degraded: linear ? [] : ['search'],
      leftOut: 0, checkedAt: this.#now(), ...(linear ? { problem: 'Each person signs in to Linear first.' } : { server: { name: 'mock-server', version: '1.0.0', protocol: '2025-06-18' } }),
    }));
  }

  /** The `mcp` system's connect page: one card per server. */
  connectPage(): ConnectPage {
    return {
      system: MCP, decl: MCP_CONNECT, ready: true, connections: [],
      instances: this.instancesOf(MCP).map((view) => ({ instance: view.instance, label: view.description || view.instance, connect: { flow: { flow: 'oauth' }, share: false, title: `Sign in to ${view.instance}` } })),
    };
  }
}
