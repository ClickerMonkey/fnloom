# Build 4

Build 4 of 7. Same rules as build 3: efficient in tokens and time.

## The request, verbatim

> Build 4
> - in full history chat mode on subsequent calls when there is no cache usage and there had been in the conversation previously add a squiggly line across the chat with the time and if its not the same day - the date... To clearly communicate when it was received without hitting the cache. Something that communicates it - maybe not all things do caching so I dont know if there's a way of knowing that for sure.
> - allow system to add aeye provider.
> - add aws provider that can work with bedrock access or API access
> - ensure web system contributes to resources so if we wanted chat agent to crawl a website it could
> - add Google calendar system that adds a page once initially configured to connect your calendar and every user can connect their calendar and then chat has fns it can use to see your events, and create and edit. On the screen where you set that up you have options for whether fns are public or not, whether it can update or create, etc. this system is mostly a test and a push to be able to support more of this stuff where it's an integration with a user in a multi user system and we need to give many options for control and privacy. This is an example of a system that's only available to the user but any system, fn, context, etc should be handled in similar way where someone can say whether it's private, public, or shared. In a single user system it's not worthwhile to display that.
> - input system and kind - adds general tool that is get_input(detailedDescription: string) which looks at past created inputs to see if any matched and if so reuses that otherwise uses an agent that can create gin types to do so and the result of get_input is a gin type and there's a front-end component that takes the input and when finished it adds a user message with the answers and data except it's in the hidden xml tags which means you shouldn't see a user message but it's really there. User messages with no content or attachments aren't visible unless you put chat in debug mode. Anyway input system also provides basic fns for easy use, get input is for complex. In the chat component where the user responds there's something like "save this form for future use" or something friendlier and that saves that as a fn in the system. All of this is similar to what's in product but not exact.
> - a fn def should have validate input and output typescript functions that's given context, args, session state, etc that just gives a pre or post execution input. Aeye supports this and it could lean on this. But this is a call from hub to system if system has this specified.. a failed pre validation could tell llm it's not available to run and why. Post validation could either say to stop or retry with explanation to user/llm.
> - The context advanced modal has inputs for fns and other context but it's a plain text box and should be a multi select search box of sorts and not plain text. Update any other place like this with poor input component choice.

## Decided (by me, from the request; the owner can overrule)

- **Cache-miss line:** the hub records, per model call, whether the provider reports cache use (read tokens) and whether
  the provider/model supports caching at all (from aeye model info, else "unknown"). In full-history mode, when a call
  reads no cache but an earlier call in the same session did, the chat draws a wavy rule across the thread at that
  message with its time (and the date when it isn't today), and a tooltip: "The model re-read the whole chat (no cache
  hit)". When caching is unknown for the model, no line.
- **Systems add aeye providers:** a system can declare one or more aeye providers in its contract (name, models, the
  provider implementation runs in the system); the hub registers them as remote providers, so model calls route over
  the link. Model calls are tracked like any other. If aeye needs a change to allow remote providers, make it on aits's
  `harness` branch.
- **AWS provider:** an aeye provider for Amazon Bedrock (Converse API: chat, tools, streaming, images in; embeddings
  via Titan/Cohere where cheap). Credentials: either an AWS access key + secret (+ region, optional session token) or a
  Bedrock API key (bearer). Lives in aits (`@aeye/aws`) if aeye has no Bedrock provider yet; configured in hub model
  settings. No AWS keys here: unit tests with recorded/fake responses; a live test marked and skipped without keys.
- **Web system → resources:** fetched pages become resources (raw HTML and converted markdown), and a `crawl` fn
  (start URL, depth, same-site, max pages, include/exclude patterns, robots.txt respected) adds every page as a resource
  under one root per crawl, so context and search see them.
- **Visibility model (the general part):** every system, fn, context item, resource root and user connection has a
  visibility: `private` (only its owner), `shared` (owner plus chosen people or groups), `public` (everyone). Systems
  can be per-user: a system declares `perUser` capabilities; each person connects their own account; the system's fns
  act as the calling person. The hub enforces visibility on every read, list, query, suggestion and fn call. In a
  single-user hub none of the controls show.
- **Google Calendar system:** a new system `google-calendar`. Admin config: an OAuth client (client id, secret,
  redirect). After that, a "Calendar" page for every person: connect with Google (OAuth code flow through the hub's
  redirect), pick calendars, and per person options: which fns are on (list/search events, get event, create, update,
  delete), whether the fns are private or shared/public, whether it may create or update without asking (an approval
  step otherwise). Tokens are stored as hub secrets per person and refreshed. No Google keys here: unit tests against a
  fake Google API; a live test marked and skipped without keys.
- **Input system and kind:** a new `input` system with an `input` kind (payload: a gin type; no deps or refs, per the
  kinds rule). Fns: `get_input(detailedDescription)` first searches saved inputs (embeddings + name) and reuses a good
  match, else an agent creates a gin type for it; plus simple fns (`ask_text`, `ask_choice`, `ask_confirm`,
  `ask_number`, `ask_date`). The chat renders the form inline (gin value editor). Submitting adds a user message whose
  content is the answers in hidden XML tags (`<input-answer>`), which the model sees but the chat hides. User messages
  with no visible content or attachments are hidden unless the chat is in debug mode (a toggle in the chat menu). Under
  a form: "Save this form for next time", which saves it as an `input` fn in the system (named, described, visibility).
  Look at product's input handling for ideas; don't copy it.
- **Fn validation hooks:** a fn definition can have `validateInput` and `validateOutput` (TypeScript, run in the
  system, given ctx, args, session state, and for output the result). The hub calls them over the link when the fn
  declares them. Input: `{ ok } | { ok: false, reason }`; a refusal tells the model the fn can't run now and why (not an
  error). Output: `{ ok } | { stop, reason } | { retry, reason }`; retry feeds the reason to the model, stop ends the
  run with the reason shown to the person. Use aeye's tool validation where it fits.
- **Pickers:** the context Advanced section's fns and context inputs become multi-select search pickers (search
  as you type, chips, keyboard). Find every other plain-text input that names things (fns, systems, context, people,
  models, resources, types) and use the right picker. One reusable component.

## Carry-overs from build 3

- The expression editor still reads like a stacked form; finish making it read like code (one line per statement,
  wrap only when nicer, labels gone where position says it).
- Remove the old narrow list filters now that every list takes `query`.
- Show the `partial` query flag ("more rows than scanned, narrow the filters") in list UIs.
- Pull a small non-reasoning Ollama model (qwen2.5:3b) for the contextor e2e and use it there.

## Rules for this build

- Lean. Browser tests only for what needs rendering; screenshots only of changed screens at 390x844 and 1440x900.
- One review round, a second only if the first finds critical or major problems.
