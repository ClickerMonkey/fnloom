/**
 * A system's `/commands` as MCP prompts. Each context with a command is a prompt named after the command, taking the
 * command's args (each arg's hint is its description). Getting a prompt is getting the context's text for those
 * args, exactly as the hub would, as one user message.
 */
import type { McpPrompt, McpPromptResult, McpPromptSource } from '@ayepi/mcp';
import type { AnyContextDef } from '../declare.ts';
import type { AskerWire } from './runtime.ts';

/** Where a context's text comes from: the system runtime. */
export interface ContextTexts {
  contextText(name: string, args: Readonly<Record<string, string>>, asker: AskerWire, signal: AbortSignal): Promise<string>;
}

/** A command, by the name MCP clients know it by. */
interface Command {
  readonly context: string;
  readonly description: string;
  readonly prompt: McpPrompt;
}

/** A contract's commands as an MCP prompt source. */
export class McpPrompts implements McpPromptSource {
  readonly #commands: ReadonlyMap<string, Command>;
  readonly #texts: ContextTexts;
  readonly #asker: () => AskerWire;

  /** `contexts` are the contract's, by local name; `asker` is who an MCP client is at the moment it asks. */
  constructor(contexts: Readonly<Record<string, AnyContextDef>>, texts: ContextTexts, asker: () => AskerWire) {
    this.#texts = texts;
    this.#asker = asker;
    this.#commands = new Map(Object.entries(contexts).flatMap(([context, def]): Array<[string, Command]> => {
      if (def.command === undefined) { return []; }
      const args = Object.entries(def.command.args).map(([name, arg]) => ({ name, description: arg.hint, required: arg.required }));
      return [[def.command.name, { context, description: def.description, prompt: { name: def.command.name, description: def.description, ...(args.length === 0 ? {} : { arguments: args }) } }]];
    }));
  }

  /** Whether the contract has any commands to offer. */
  get empty(): boolean {
    return this.#commands.size === 0;
  }

  prompts(): McpPrompt[] {
    return [...this.#commands.values()].map((command) => command.prompt);
  }

  async get(name: string, args: Readonly<Record<string, string>>, signal: AbortSignal): Promise<McpPromptResult | undefined> {
    const command = this.#commands.get(name);
    if (command === undefined) { return undefined; }
    const text = await this.#texts.contextText(command.context, args, this.#asker(), signal);
    return { description: command.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }
}
