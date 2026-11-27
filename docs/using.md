# First steps with fnloom

Once `fnloom start` is running and you have signed in as the admin (see [Installing and running it](install.md)), these
are the first things most people do. Every page named here is in the app's side bar; **Admin** pages are for admins.

## Connect a model

**Admin › Models › Add provider.** Pick OpenRouter (one key, hundreds of models), an OpenAI-compatible server, Amazon
Bedrock, or a local Ollama. If you set `OPENROUTER_API_KEY` before the first start, OpenRouter is already there. Each
chat can then use a different model.

## Chat

Open **Chat** and ask for something in plain words. While it works, each fn it calls shows as a card with its live
status and progress; changes that need your yes appear as approval cards, in the chat and in your **Inbox** (which also
holds notifications). Every answer shows what it cost.

## Give it more to work with

- **Files:** the fs system serves the folder you started `fnloom` in. Ask about its files, or have it run commands.
- **More systems:** `fnloom system available` lists the premade ones; `fnloom system install database` (with widgets),
  `web`, `claude` and the rest add databases and charts, web search and reading, and Claude Code sessions. Manage
  them under **Admin › Systems**.
- **MCP servers:** **Admin › Systems › MCP servers** adds one (stdio, HTTP or SSE); its tools become fns.
- **Web APIs:** **Admin › Systems › API services**, or ask the agent to connect a service from its API description.
- **Context:** the **Context** page holds guides, rules and memories. The right ones are picked for each message.
- **Data:** the **Data** page lists the records the hub keeps and the charts you saved.

## Let it build fns and systems

Ask it to make something repeatable ("keep this as a fn", "do this every morning"): it writes a fn of the right kind
(a code program, a saved query, an API request, a schedule) that then runs without a model. It can also write a whole
new system; an admin reviews it under **Admin › Systems** before it goes live.

## Add people and set limits

- **Admin › People › Add person** creates an account; each person has their own chats and private memories.
- **Admin › Policies** decides what each person can see, use and change.
- **Admin › Models › Budgets** sets spending limits for the hub, a group, a person, a chat or a single message.

## Use it on your phone

**Settings › App › Use it on your phone** shows a QR code and the steps to trust the hub's HTTPS certificate; then the
app installs to the phone's home screen, with notifications.
