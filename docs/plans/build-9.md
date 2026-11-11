# Build 9

It starts after build 8.

## The request, verbatim (2026-11-11)

> And build 9
> - mcp system - you enter whatever mcp info, maybe it supports multiple auth methods to hook it up from browser, then you have a system available.
> - code & API systems like in product
> - Claude system that can create sessions in folders, see active seasons, send messages, handle Claude needing approval or having questions... Or communicating workflows and their progress.... Etc. all the Claude code features made available through a system so I can manage a fleet of them

## Prior art to read

In product (`C:\Users\pdiff\Documents\GitHub\product\design`):
- mcp-system.md
- claude-code-system.md
- api-kind.md, api-def.md and api-spec.md
- the code kind, its agent and tests in product's code

Also in harness: the hub MCP endpoints and `@ayepi/mcp` (build 2), and the build 7 authoring-agent helper and test kit,
which the code and API systems use.

## Notes for the design step (my reading; the owner can overrule)

- **MCP system:**
  - In the browser you add an MCP server: stdio command, HTTP or SSE URL.
  - Auth can be none, a bearer token, headers, or OAuth (the browser flow through the hub's connect callback, per
    person when the server is per-user).
  - Each MCP server becomes a system instance. Its tools, resources and prompts become fns, resources and commands,
    with visibility and approvals.
- **Code and API systems:** as in product. Authoring goes through the build 7 authoring agent, with a forced workflow
  and progressive disclosure, and with the native test kit.
- **Claude system:** manages a fleet of Claude Code sessions.
  - **Sessions:** create sessions in folders, list active ones, read their transcripts, send messages, and interrupt
    or stop them.
  - **Needs attention:** surface what Claude needs: approvals and questions, as approval cards and input forms in the
    harness chat and inbox.
  - **Workflows:** show workflows and their progress.
  - **Imports:** import Claude's agents, skills and MCP servers as context and fns.
  - It is built on the Claude Agent SDK or the Claude Code CLI, whichever the design finds best.
