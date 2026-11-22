# Prompt and tool-doc rewrite (after scenario iteration 1)

What the chat agent's system prompt, the tool descriptions, fn and kind instructions and context items must explain,
so a model that only knows generic tool calling can work the harness well. Built after the iteration 1 baseline
(`npm run scenarios`), informed by the diagnostician's ranked fixes, then measured by iteration 2.

## Phil's words (2026-11-21)

> My core critique of the code you've produced is that the instructions and prompts are weak and you're creating them
> from your perspective which already has the context and you're not thinking of these things from another less capable
> models perspective. There should be some judge that looks at a whole turn and decide what went wrong and why and I've
> found it's often a lack of information or using the right mechanisms.

> Right but does the model understand the system to know what fns are? You do.... But it's been trained with the
> concept of tools. Fns need to be explained. The systems need to be listed and their details need to explain what sort
> of fns they have, if they have fn kinds, what that even means. Etc. assume it doesn't understand anything without a
> verbose explanation. Also the person may be technical - the technical ability doesn't need to be communicated in the
> prompt because we don't know. With a good system prompt and well documented tools that inform doesn't matter it can
> infer it based on the quality of the message which is something llms do naturally.
>
> I think Luna is perfectly fine for this, I use to use gpt-4o and got good results with a more complex system.

> And can sometimes be undone*
>
> And the user might send messages during tool execution and it may put them in the background etc. those behaviors also
> need to be explained. There are others. And explain the different xml things that could be present in the user message
> and why

> Verify tool calls are sending json schema and if examples are available are sending at least one. And json schema
> should try to be sent strict, let aeye dynamically handle transforming the schema based on the model.

## What the prompt must explain (assume the model knows none of it)

- **Fns.** A fn is what the model calls a tool, owned by a system and named `system/name`. Not every fn is in the tool
  list: most are found with search and loaded first. Some are written from data (a kind's payload) and kept. A run can
  need approval, is recorded, and *can sometimes* be undone (only fns that declare undo).
- **Systems.** Each one listed with what it is for, what sort of fns it has, whether it defines fn kinds, and when to
  reach for it.
- **Fn kinds.** What a kind is, which systems define one (code, api, database queries, input forms, widgets, mcp tools,
  agents), and what authoring a fn of that kind means: a lasting thing the person can use again.
- **Context and memory.** What a context item is, what loading one brings along (imports, fns), commands, memory and
  when to remember.
- **Asking the person.** Typed input forms versus `hub/ask_user` versus just answering.
- **Runtime behaviour.** Among others, the person may send a message while tools run: those runs move to the
  background, the model gets "still running" results and can answer at once, and background runs report back when they
  finish (`hub/run_status`, `hub/run_wait`). Also: the global tool timeout, approvals that wait for a person, refusals
  and their reasons (stop and say so), invalid input coming back to retry, calls held because they claim the same thing,
  the step limit and Continue, undo and retry of a turn, systems turning on and off.
- **Every tagged block that can appear in a user message, and why it is there**: `<local_time>`, system hook blocks
  (such as `<fs_git>`), `<mention>`, suggestion cards (`<suggested_fns>`, `<suggested_context>`, `<fn>`, `<context>`),
  `<systems_changed>`, input answers, attached files, and the rest. The full list is taken from the code, not memory.
- **Tool calls.** Every tool carries its JSON schema, sent strict where the model supports it (aeye adapts the schema
  per model), and at least one example whenever the fn has one.
- **Never** state the person's technical level. A good prompt and well-documented tools let the model infer it from
  the message.
