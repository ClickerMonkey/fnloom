/**
 * The Ollama page's logic, apart from its drawing so tests read it plainly: the instances of the system as the hub
 * lists them, their configs, offering a model (a new config with it in `offered`, or out), and how sizes and states
 * read.
 */
import type { InstanceName, Json, SystemView } from '@harness/core';
import type { PartTone } from '@harness/sdk';
import { ModelList, OllamaConfig, OllamaStatus, taggedModel, type InstalledModel, type OfferedModel, type ServerState } from '../shared/index.ts';

/** One instance as the page lists it. */
export interface PageInstance {
  readonly instance: InstanceName;
  /** Whether the hub has it connected now. */
  readonly connected: boolean;
  /** Its config, parsed; undefined while it has none (or an invalid one). */
  readonly config: OllamaConfig | undefined;
  /** Its config as the hub holds it, for writing back. */
  readonly raw: Json | undefined;
}

/** What the page reads of the system as the hub lists it. */
export type SystemInstances = { readonly instances: ReadonlyArray<Pick<SystemView['instances'][number], 'instance' | 'status'> & { readonly config?: { readonly value: Json } | undefined }> };

/** The ollama system's instances, by name. */
export function instancesOf(view: SystemInstances | undefined): PageInstance[] {
  if (view === undefined) { return []; }
  return view.instances.map((instance): PageInstance => {
    const value = instance.config?.value;
    const parsed = OllamaConfig.safeParse(value);
    return {
      instance: instance.instance, connected: instance.status === 'connected',
      config: value === undefined || !parsed.success ? undefined : parsed.data, raw: value,
    };
  }).sort((a, b) => a.instance.localeCompare(b.instance));
}

/** The config with a model offered (with its limits) or no longer offered, as the hub stores it. */
export function withOffer(config: OllamaConfig, model: string, offer: Omit<OfferedModel, 'model'> | undefined): OllamaConfig {
  const tagged = taggedModel(model);
  const rest = config.offered.filter((o) => taggedModel(o.model) !== tagged);
  return { ...config, offered: offer === undefined ? rest : [...rest, { ...offer, model: tagged }] };
}

/** The offer an admin has for a model, if any. */
export function offerFor(config: OllamaConfig | undefined, model: string): OfferedModel | undefined {
  const tagged = taggedModel(model);
  return config?.offered.find((o) => taggedModel(o.model) === tagged);
}

/** Bytes as people read them: `5.2 GB`, `274 MB`. */
export function bytes(size: number): string {
  if (size >= 1e9) { return `${(size / 1e9).toFixed(1)} GB`; }
  if (size >= 1e6) { return `${Math.round(size / 1e6)} MB`; }
  return size >= 1e3 ? `${Math.round(size / 1e3)} kB` : `${size} B`;
}

/** How a server's state reads, and its colour. */
export function stateOf(state: ServerState, answering: boolean): { label: string; tone: PartTone } {
  switch (state) {
    case 'running': return { label: 'Running', tone: 'ok' };
    case 'starting': return { label: 'Starting', tone: 'accent' };
    case 'stopping': return { label: 'Stopping', tone: 'accent' };
    case 'crashed': return { label: 'Restarting after a crash', tone: 'warn' };
    case 'failed': return { label: 'Crashed too often', tone: 'danger' };
    case 'external': return answering ? { label: 'Answering', tone: 'ok' } : { label: 'Not answering', tone: 'danger' };
    case 'stopped': return { label: 'Stopped', tone: 'neutral' };
  }
}

/** What an instance can be asked to do now, by its status. */
export function actionsOf(status: OllamaStatus | undefined): { install: boolean; start: boolean; stop: boolean } {
  if (status === undefined) { return { install: false, start: false, stop: false }; }
  const runs = status.mode !== 'url';
  const up = status.state === 'running' || status.state === 'starting' || status.state === 'crashed';
  return { install: status.mode === 'managed', start: runs && !up && (status.mode !== 'managed' || status.installed !== undefined), stop: runs && up };
}

/** A model's abilities as a short line (`tools · vision · 40k context`). */
export function abilities(model: InstalledModel): string {
  const shown = model.capabilities.filter((c) => c !== 'chat' && c !== 'streaming' && c !== 'json');
  const window = model.contextLength === undefined ? `${Math.round(model.servedWindow / 1024)}k served` : `${Math.round(model.contextLength / 1024)}k context, ${Math.round(model.servedWindow / 1024)}k served`;
  return [...shown, window].join(' · ');
}

/** A status read from the hub's quiet read. */
export function readStatus(value: Json): OllamaStatus {
  return OllamaStatus.parse(value);
}

/** A model list read from the hub's quiet read. */
export function readModels(value: Json): InstalledModel[] {
  return ModelList.parse(value).models;
}

/** Whether a checkbox's change left it checked. */
export function checkedOf(event: Event): boolean {
  return event.target instanceof HTMLInputElement && event.target.checked;
}

/** What a field's change left in it. */
export function valueOf(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}

/** Why something failed, in words. */
export function problemText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}
