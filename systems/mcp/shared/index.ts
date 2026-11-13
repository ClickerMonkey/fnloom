/**
 * The MCP system's contract (`shared/`): the harness as an MCP client. Every MCP server a person adds is an instance
 * of this system (config core's `McpServerConfig`: stdio, HTTP or SSE; auth none, bearer, headers or OAuth, shared or
 * per person). The instance mirrors the server into the hub while it runs: each tool is a fn of kind `mcp/tool`
 * (`<instance>_<tool>`, run on that instance), each prompt a context item with a `/command`, each resource a hub
 * resource under `mcp://<instance>/`. Lists are mirrored again when the server says they changed; nothing is removed
 * when a server is down, so its fns stay and fail plainly until it is back. A question the server asks during a call
 * (an MCP elicitation) becomes a form on an approval card (`answer_elicitation`).
 */
import { ConnectDecl, MCP_CONFIG_SECRETS, MCP_SYSTEM, McpServerConfig, McpServerStatus, McpToolSpec } from '@harness/core';
import { fn, g, ginAs, kind, system, wireType } from '@harness/sdk';
import { ElicitationReply, ElicitationSent, ServerOp, ServerTarget, ToolOutput } from './shapes.ts';

export * from './shapes.ts';

/** A tool result's gin type when the tool declares no output schema. */
export const ToolOutputType = ginAs(ToolOutput);

/** How a status is worded on the run card. */
const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: `${active} (again)`, many: `${active} (again)` },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/**
 * The system's `connect`: connections are per instance (each server says how people sign in to it with
 * `instanceConnect`), and every tool fn acts as the person's connection to its server. Tools are on and act without
 * asking by default; the server's own approval policy (`McpServerConfig.approval`) still asks where it says to.
 */
export const MCP_CONNECT: ConnectDecl = ConnectDecl.parse({
  title: 'MCP servers',
  description: 'Sign in to the MCP servers that need your own account, so the chat can use their tools as you.',
  icon: 'plug',
  how: { flow: 'oauth' },
  settings: wireType(g.obj({})),
  fns: {},
  scope: 'instance',
  defaults: { on: true, ask: false },
});

/**
 * The config paths sealed as secrets. Core's `MCP_CONFIG_SECRETS` also names `transport.env` and `auth.values`, but
 * those are records of text, and the SDK and the hub seal text fields only (`checkedSecrets` refuses the rest): until
 * they seal records, those two are kept as plain config.
 */
const SEALED_SECRETS = MCP_CONFIG_SECRETS.filter((path) => path !== 'transport.env' && path !== 'auth.values');

const declared = system(MCP_SYSTEM, {
  description: 'Use the tools, prompts and resources of MCP servers: each server added is an instance, its tools are fns, its prompts are /commands and its resources are browsable.',
  groups: [
    { name: 'servers', title: 'Servers', description: 'Where each MCP server is (connected, needs sign-in, unreachable) and listing its tools again.' },
    { name: 'instances', title: 'Instances', description: 'Work forwarded to the instance that holds a server; called by this system\'s own fns only.' },
  ],
  configSecrets: SEALED_SECRETS,
  // tool calls may ask a person (elicitations) and act as their connection; each server is wherever its URL says
  grants: { hub: ['approvals', 'connections', 'resources'], network: ['*'] },
})
  .with({
    config: ginAs(McpServerConfig),
    kinds: {
      tool: kind({
        description: 'One tool of an MCP server, mirrored into the hub: its args and result are the server\'s JSON Schemas read as gin types, and a run calls the tool on the server.',
        applicability: 'Made by an MCP server instance from its server\'s tool list; never written by hand.',
        payload: ginAs(McpToolSpec),
        // the instance adds and changes its tools as the server lists them; calls still ask by the server's policy
        approveChanges: false,
        status: status('Calling {fn}…', 'Called {fn}', '{fn} failed'),
      }),
    },
    fns: {
      at_server: fn({
        group: 'instances',
        description: 'Do a server fn\'s work on the instance that holds the server (the fns forward here with `on`).',
        instructions: 'Called by this system\'s own fns only.',
        args: ginAs(ServerOp),
        returns: ginAs(McpServerStatus),
        examples: [{ args: { op: 'status' }, note: 'Where this instance\'s server is.' }],
        visibility: 'none',
        display: 'hidden',
        effects: { mode: 'read', free: true },
      }),
      answer_elicitation: fn({
        group: 'instances',
        description: 'Send a person\'s answer to a question an MCP server asked during a tool call.',
        instructions: 'Proposed by the instance when a server asks; the approval card\'s form fills `content`. Never called by a model.',
        args: ginAs(ElicitationReply),
        returns: ginAs(ElicitationSent),
        examples: [{ args: { request: 'e1', content: { project: 'Website' } }, result: { sent: true }, note: 'The person picked a project.' }],
        visibility: 'user',
        display: 'hidden',
        effects: { mode: 'read', free: true },
      }),
    },
  })
  .with(({ fns }) => ({
    fns: {
      server_status: fn({
        group: 'servers',
        description: 'Where an MCP server is: connected, needs sign-in, unreachable or failed, what it said about itself, and how many tools, prompts and resources it offers.',
        instructions: 'Call it when a server\'s tools fail, to say why in plain words.',
        args: ginAs(ServerTarget),
        returns: ginAs(McpServerStatus),
        deps: { at: fns.at_server },
        examples: [{ args: { instance: 'linear' }, note: 'The Linear server\'s status.' }],
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['mcp', 'read'],
      }),
      refresh: fn({
        group: 'servers',
        description: 'List an MCP server\'s tools, prompts and resources again and mirror them into the hub, then say where it is.',
        instructions: 'Servers say when their lists change, so call it only when a person asks or a tool is missing.',
        args: ginAs(ServerTarget),
        returns: ginAs(McpServerStatus),
        deps: { at: fns.at_server },
        examples: [{ args: { instance: 'linear' }, note: 'Mirror the Linear server again.' }],
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['mcp'],
      }),
    },
  }));

/** The MCP system's contract: its fns, its tool kind and the per-instance `connect` the tools act through. */
export const mcp = declared.with({ connect: MCP_CONNECT });

/** The contract's type. */
export type McpContract = typeof mcp;
