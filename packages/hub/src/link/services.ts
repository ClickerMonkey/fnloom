/**
 * The hub link endpoints that hand a system the hub's shared services, as one plugin: content (`upload` in base64
 * chunks, `content` read back in chunks), session state (`stateGet`, `stateSet`, only the fields the owner
 * declared), settings (`setting`, the value for the run's user) and attachments (`attach`, onto the run's
 * assistant message, the data checked against the attachment's type first), and named types (`types`, a set of
 * qualified type names and every type they reference, so a system can load what another system declared).
 *
 * Everything runs behind `linkSession` (bound by the link plugin), so `link` is the system asking.
 */
import { reject as refuse, spec } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import {
  hubLinkSpec, type ActorId, type AttachmentDecl, type ContentRef, type Json, type Link, type LinkSession, type QualifiedName, type Run, type RunId, type StateOwner, type TypeRecord,
} from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { Catalog } from '../catalog/index.ts';
import type { AttachedPart, StateService } from '../chat/index.ts';
import type { LinkHandler } from '../execution/link-handlers.ts';
import type { HubStore } from '../store/index.ts';

const endpoints = hubLinkSpec.endpoints;

/** The slice of `hubLinkSpec` these services answer: the same endpoint objects, so its types are the spec's. */
export const SERVICES_SPEC = spec({
  endpoints: {
    upload: endpoints.upload, content: endpoints.content, stateGet: endpoints.stateGet, stateSet: endpoints.stateSet,
    setting: endpoints.setting, attach: endpoints.attach, types: endpoints.types,
  },
});

/** An endpoint these services answer. */
export type ServiceEndpoint = keyof (typeof SERVICES_SPEC)['endpoints'];

/** What the services read from the catalog. */
export interface ServiceCatalog extends Pick<Catalog, 'check' | 'typeClosure' | 'type'> {
  /** An attachment's declaration, if a system declares it. */
  attachment(name: QualifiedName): Promise<AttachmentDecl | undefined>;
}

/** The services' view of the catalog. */
export function serviceCatalog(catalog: Catalog): ServiceCatalog {
  return {
    attachment: async (name) => (await catalog.entries('attachments')).find((entry) => entry.name === name)?.decl,
    check: (system, type, value) => catalog.check(system, type, value),
    typeClosure: (names) => catalog.typeClosure(names),
    type: (name) => catalog.type(name),
  };
}

/** What the services read. Each is looked up when a call arrives, so the plugin can be made before the modules are. */
export interface LinkServiceDeps {
  readonly store: () => HubStore;
  readonly catalog: () => ServiceCatalog;
  readonly content: () => Pick<ContentStore, 'put' | 'has' | 'read'>;
  readonly state: () => Pick<StateService, 'get' | 'set'>;
  /** Where attachments go (chat's `TurnService.attach`; what it returns isn't used). */
  readonly turns: () => { attach(run: RunId, part: AttachedPart): Promise<unknown> };
  /** The largest upload, in bytes. */
  readonly maxUpload: number;
  /** An upload not finished within this long is dropped. */
  readonly uploadTtl: number;
  readonly clock: () => number;
}

/** An upload being received. */
interface Upload {
  readonly chunks: Buffer[];
  size: number;
  readonly startedAt: number;
}

/** Uploads in progress, per system, so two systems' upload ids can't collide. */
export class ChunkedUploads {
  readonly #open = new Map<string, Upload>();
  readonly #deps: Pick<LinkServiceDeps, 'content' | 'maxUpload' | 'uploadTtl' | 'clock'>;

  constructor(deps: Pick<LinkServiceDeps, 'content' | 'maxUpload' | 'uploadTtl' | 'clock'>) {
    this.#deps = deps;
  }

  /** Add a base64 chunk; the last one stores the bytes and returns their ref. */
  async add(link: LinkSession, input: { upload: string; chunk: string; last: boolean; mime: string }): Promise<{ ref?: ContentRef }> {
    this.#sweep();
    const key = `${link.system}\u0000${input.upload}`;
    const upload = this.#open.get(key) ?? { chunks: [], size: 0, startedAt: this.#deps.clock() };
    const bytes = Buffer.from(input.chunk, 'base64');
    upload.size += bytes.length;
    if (upload.size > this.#deps.maxUpload) {
      this.#open.delete(key);
      throw refuse(413, 'TOO_LARGE', `uploads are limited to ${this.#deps.maxUpload} bytes`);
    }
    upload.chunks.push(bytes);
    if (!input.last) {
      this.#open.set(key, upload);
      return {};
    }
    this.#open.delete(key);
    return { ref: await this.#deps.content().put(Buffer.concat(upload.chunks), input.mime) };
  }

  /** How many uploads are in progress. */
  get size(): number {
    return this.#open.size;
  }

  #sweep(): void {
    const oldest = this.#deps.clock() - this.#deps.uploadTtl;
    for (const [key, upload] of this.#open) { if (upload.startedAt < oldest) { this.#open.delete(key); } }
  }
}

/** What the hub does for linked systems, one method per endpoint, each taking the system asking (`link`). */
export class LinkServices {
  readonly #deps: LinkServiceDeps;
  readonly #uploads: ChunkedUploads;

  constructor(deps: LinkServiceDeps) {
    this.#deps = deps;
    this.#uploads = new ChunkedUploads(deps);
  }

  /** Add a chunk of an upload; the last returns the content's ref. */
  upload(link: LinkSession, input: { upload: string; chunk: string; last: boolean; mime: string }): Promise<{ ref?: ContentRef }> {
    return this.#uploads.add(link, input);
  }

  /** A slice of stored content, in base64. */
  async content(input: { ref: ContentRef; offset: number; length: number }): Promise<{ chunk: string }> {
    const content = this.#deps.content();
    if (!await content.has(input.ref)) { throw refuse(404, 'CONTENT_NOT_FOUND', `no content ${input.ref.hash}`); }
    return { chunk: Buffer.from(await content.read(input.ref, input.offset, input.length)).toString('base64') };
  }

  /** Session state for one of the system's own runs, or a delivery. */
  async stateGet(link: LinkSession, owner: StateOwner): ReturnType<StateService['get']> {
    await this.#owned(link, owner);
    return this.#deps.state().get(owner);
  }

  async stateSet(link: LinkSession, owner: StateOwner, input: Parameters<StateService['set']>[1]): ReturnType<StateService['set']> {
    await this.#owned(link, owner);
    return this.#deps.state().set(owner, input);
  }

  /** A setting's value for the person a run is for: theirs, else their first group's that sets it. */
  async setting(link: LinkSession, input: { run: RunId; setting: QualifiedName }): Promise<{ value?: Json }> {
    const store = this.#deps.store();
    const run = await this.#ownRun(link, input.run);
    const user = (await store.table('turns').get(run.turn))?.user.id ?? run.actor;
    const value = await settingOf(store, input.setting, user) ?? await groupSetting(store, input.setting, user);
    return value === undefined ? {} : { value };
  }

  /** Attach a link, or a system attachment whose data fits its declared type, to the run's assistant message. */
  async attach(link: LinkSession, input: { run: RunId; item: { link: Link } | { attachment: QualifiedName; data: Json; title: string } }): Promise<void> {
    const run = await this.#ownRun(link, input.run);
    if ('link' in input.item) {
      await this.#deps.turns().attach(run.id, { type: 'link', link: input.item.link });
      return;
    }
    const { attachment, data, title } = input.item;
    const catalog = this.#deps.catalog();
    const decl = await catalog.attachment(attachment);
    if (decl === undefined) { throw refuse(404, 'NO_ATTACHMENT', `no attachment ${attachment}`); }
    const problems = await catalog.check(run.system, decl.data, data);
    if (problems.length > 0) { throw refuse(400, 'BAD_ATTACHMENT', `${attachment}: ${problems.join('; ')}`); }
    await this.#deps.turns().attach(run.id, { type: 'attachment', attachment, data, title });
  }

  /** Named type definitions and every named type they reference, dependencies first, with the names not found. */
  async types(names: readonly QualifiedName[]): Promise<{ types: TypeRecord[]; missing: string[] }> {
    const catalog = this.#deps.catalog();
    const closure = await catalog.typeClosure(names);
    const records = await Promise.all(closure.order.map((name) => catalog.type(name)));
    return { types: records.flatMap((record) => (record === undefined ? [] : [record])), missing: closure.missing };
  }

  /** The run a system names, refused unless that system ran it. */
  async #ownRun(link: LinkSession, id: RunId): Promise<Run> {
    const run = await this.#deps.store().table('runs').get(id);
    if (run === undefined) { throw refuse(404, 'RUN_NOT_FOUND', `no run ${id}`); }
    if (run.system !== link.system) { throw refuse(403, 'NOT_YOUR_RUN', `run ${id} belongs to ${run.system}`); }
    return run;
  }

  /** Refuse state of a run the system didn't run, or of a delivery to another system. */
  async #owned(link: LinkSession, owner: StateOwner): Promise<void> {
    if ('run' in owner) {
      await this.#ownRun(link, owner.run);
      return;
    }
    const delivery = await this.#deps.store().table('deliveries').get(owner.delivery);
    if (delivery === undefined) { throw refuse(404, 'DELIVERY_NOT_FOUND', `no delivery ${owner.delivery}`); }
    if (delivery.system !== link.system) { throw refuse(403, 'NOT_YOUR_DELIVERY', `delivery ${owner.delivery} went to ${delivery.system}`); }
  }
}

/** The handlers: each endpoint's body handed to its `LinkServices` method. */
export function linkServiceHandlers(services: LinkServices): { [K in ServiceEndpoint]: LinkHandler<K> } {
  return {
    upload: ({ data, link }) => services.upload(link, data),
    content: ({ data }) => services.content(data),
    stateGet: ({ data, link }) => services.stateGet(link, data.owner),
    stateSet: ({ data: { owner, patch, clear, version }, link }) => services.stateSet(link, owner, { patch, clear, ...(version === undefined ? {} : { version }) }),
    setting: ({ data, link }) => services.setting(link, data),
    attach: ({ data, link }) => services.attach(link, data),
    types: ({ data }) => services.types(data.names),
  };
}

/** The most groups a user's settings are looked up in. */
const MAX_GROUPS = 100;

/** The value an actor set for a setting, if any. */
async function settingOf(store: HubStore, setting: QualifiedName, actor: ActorId): Promise<Json | undefined> {
  return (await store.table('actorSettings').find({ where: { setting, actor }, limit: 1 })).items[0]?.value;
}

/** A setting's value from the first of the user's groups that sets it. */
async function groupSetting(store: HubStore, setting: QualifiedName, user: ActorId): Promise<Json | undefined> {
  const groups = await store.table('memberships').find({ where: { user }, limit: MAX_GROUPS });
  for (const membership of groups.items) {
    const value = await settingOf(store, setting, membership.group);
    if (value !== undefined) { return value; }
  }
  return undefined;
}

/** The services as a link plugin. */
export function linkServicesPlugin(deps: LinkServiceDeps) {
  const services = new LinkServices(deps);
  return plugin({ name: 'link.services', spec: SERVICES_SPEC }).handlers(() => linkServiceHandlers(services));
}
