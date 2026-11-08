/**
 * Hub MCPs: the list (with sessions open now and calls today) and making one, and one MCP's page: its settings, its
 * rules as a draft with the live preview of what they expose (asked again as the draft changes, only the latest
 * answer counting), saving, enabling, rotating its secret, deleting it, its open sessions, and trying it from the
 * browser with its secret. A secret is shown once, when it is made or rotated: the store keeps it in memory only
 * until the page closes.
 */
import type { HubMcpId, HubMcpInput, HubMcpView, McpRules, McpScopePreview, McpSessionView } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';
import type { McpProbe, ProbeResult } from '../probe.ts';

type McpsApi = Pick<AdminApi, 'mcps' | 'createMcp'>;
type McpApi = Pick<AdminApi, 'mcp' | 'updateMcp' | 'rotateMcpSecret' | 'deleteMcp' | 'previewMcp' | 'mcpSessions'>;

/** The MCPs list. */
export class McpsStore {
  readonly #api: McpsApi;
  readonly list = new Loaded<readonly HubMcpView[]>();
  readonly create = new Task();

  constructor(api: McpsApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await this.list.load(() => this.#api.mcps.call({}), "Couldn't load the MCPs.", quiet);
  }

  /** Make an MCP; answers it with its secret (the only time the secret is shown). */
  async make(input: HubMcpInput): Promise<Outcome<{ mcp: HubMcpView; secret: string }>> {
    const result = await this.create.run(() => this.#api.createMcp.call(input), "Couldn't make that MCP.");
    if (result.ok) { this.list.set([...(this.list.value.value ?? []), result.value.mcp]); }
    return result;
  }
}

/** One MCP's page. */
export class McpStore {
  readonly #api: McpApi;
  readonly #probe: McpProbe;
  readonly id = ref<HubMcpId | undefined>(undefined);
  readonly view = new Loaded<HubMcpView>();
  readonly sessions = new Loaded<readonly McpSessionView[]>();
  /** The rules being edited (the saved ones until changed). */
  readonly draft = shallowRef<McpRules | undefined>(undefined);
  readonly preview = new Loaded<McpScopePreview>();
  readonly save = new Task();
  readonly rotate = new Task();
  readonly remove = new Task();
  /** The secret made or rotated on this page, until it closes. */
  readonly secret = ref('');
  readonly tried = new Loaded<ProbeResult>();
  /** Whether the draft differs from the saved rules. */
  readonly changed = computed(() => this.draft.value !== undefined && JSON.stringify(this.draft.value) !== JSON.stringify(this.view.value.value?.rules));

  constructor(api: McpApi, probe: McpProbe) {
    this.#api = api;
    this.#probe = probe;
  }

  /** Show an MCP (and, when it was just made, the secret it came with). */
  async open(id: HubMcpId, secret = ''): Promise<void> {
    if (this.id.value !== id) { this.close(); }
    this.id.value = id;
    if (secret !== '') { this.secret.value = secret; }
    await this.view.load(() => this.#api.mcp.call({ mcp: id }), "Couldn't load this MCP.", this.view.value.value?.id === id);
    const view = this.view.value.value;
    if (view !== undefined && this.draft.value === undefined) { this.edit(view.rules); }
  }

  close(): void {
    this.id.value = undefined;
    this.view.reset();
    this.sessions.reset();
    this.preview.reset();
    this.tried.reset();
    this.draft.value = undefined;
    this.secret.value = '';
  }

  /** Change the draft rules and ask what they would expose. */
  edit(rules: McpRules): void {
    this.draft.value = rules;
    void this.preview.load(() => this.#api.previewMcp.call({ rules }), "Couldn't preview these rules.", this.preview.value.value !== undefined);
  }

  /** Put the draft back to the saved rules. */
  revert(): void {
    const view = this.view.value.value;
    if (view !== undefined) { this.edit(view.rules); }
  }

  /** Save a change to the MCP (the draft rules unless the change names its own). */
  async update(change: Partial<HubMcpInput> = {}): Promise<Outcome<HubMcpView>> {
    const id = this.id.value;
    if (id === undefined) { return { ok: false, problem: 'No MCP is open.' }; }
    const rules = change.rules ?? this.draft.value;
    const result = await this.save.run(() => this.#api.updateMcp.call({ mcp: id, ...change, ...(rules === undefined ? {} : { rules }) }), "Couldn't save the MCP.");
    if (result.ok) {
      this.view.set(result.value);
      this.draft.value = result.value.rules;
    }
    return result;
  }

  /** A new secret; every open session ends. Kept to show once. */
  async rotateSecret(): Promise<Outcome<{ secret: string }>> {
    const id = this.id.value;
    if (id === undefined) { return { ok: false, problem: 'No MCP is open.' }; }
    const result = await this.rotate.run(() => this.#api.rotateMcpSecret.call({ mcp: id }), "Couldn't rotate the secret.");
    if (result.ok) {
      this.secret.value = result.value.secret;
      this.sessions.set([]);
    }
    return result;
  }

  async delete(): Promise<boolean> {
    const id = this.id.value;
    if (id === undefined) { return false; }
    const result = await this.remove.run(() => this.#api.deleteMcp.call({ mcp: id }), "Couldn't delete the MCP.");
    return result.ok && result.value.ok;
  }

  async loadSessions(quiet = false): Promise<void> {
    const id = this.id.value;
    if (id === undefined) { return; }
    await this.sessions.load(() => this.#api.mcpSessions.call({ mcp: id }), "Couldn't load this MCP's sessions.", quiet);
  }

  /** Try the MCP as a client would, with `secret` (the one shown on this page when blank). */
  async tryIt(secret: string): Promise<void> {
    const view = this.view.value.value;
    const key = secret.trim() === '' ? this.secret.value : secret.trim();
    if (view === undefined || key === '') { return; }
    await this.tried.load(() => this.#probe.tools(view.url, key), "Couldn't reach the MCP with that secret.");
  }
}
