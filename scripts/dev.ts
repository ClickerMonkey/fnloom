/**
 * `npm run dev`: builds the web app, then runs the hub (serving that build), the fs system (with this repository as
 * its root), the embedder and input systems, the web system when `TAVILY_API_KEY` is set and the calendar system when
 * `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are, all bound to the LAN and
 * restarting when their source changes, and when they crash or stop answering (after HARNESS_DEV_RESTART_DELAY,
 * with why in `<HARNESS_DATA>/logs/crashes.log`). Output is prefixed and coloured per process; Ctrl+C stops them all. Settings
 * come from the environment or `.env`:
 *
 *   HARNESS_ADMIN_EMAIL / HARNESS_ADMIN_PASSWORD   the single admin account (required; made on first start)
 *   HARNESS_PORT       hub and web app port (default 4300)
 *   HARNESS_DATA       data folder (default .harness)
 *   HARNESS_DEV_ONLY   comma list of what to run: web (the build), hub, fs, embedder, web-system, input, widgets, code, claude, calendar, ollama,
 *                      database (default all but database, which runs a new SQLite file `dev.db` only when listed)
 *   HARNESS_DEV_ROOT   the folder fs serves (default this repository)
 *   HARNESS_EMBEDDER_URL  the EmbeddingGemma service (default http://127.0.0.1:8760)
 *   TAVILY_API_KEY     the web system's search key; without it the web system doesn't run
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   the calendar's OAuth client; without them it doesn't run
 *   HARNESS_DEV_OLLAMA the ollama system's Ollama: an address of one that runs on its own, or managed (its own, installed
 *                      in its data folder once an admin approves); without it the ollama system doesn't run
 *
 * For a stack that edits to this tree can't restart, see `npm run live` (`scripts/live.ts`).
 *
 * For the web app with hot reload instead of a build, run `npm run dev:web` beside it (Vite on HARNESS_WEB_PORT).
 */
import { runStack } from './run-stack.ts';

await runStack({ name: 'dev', watch: true });
