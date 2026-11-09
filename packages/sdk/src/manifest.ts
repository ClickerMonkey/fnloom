/**
 * The manifest: a contract as JSON, the way the hub receives it. Built from the typed contract, so the two can't
 * disagree, and checked against core's `Manifest` schema before it leaves.
 */
import {
  DeclaredLink, Json, LinkTarget, Manifest, SystemName, splitName, SYSTEM_EVENT_TYPES,
  type ActionDecl, type ClientAssets, type ConnectDecl, type ContextDecl, type FnDecl, type HandlerDecl, type QualifiedName, type SystemEventType,
  type TypeDecl, type GinTypeDef,
} from '@harness/core';
import type { AnyContextDef, AnyTypeDef, ContextLinkTarget } from './declare.ts';
import { progressDecl, validationOf, type AnyFnDef, type Handlers } from './fn.ts';
import { encodeValue, referencesOf, wireType } from './gin.ts';
import { providerDecl } from './providers.ts';
import type { AnyContract, ContractShape } from './system.ts';
import { entriesOf } from './util.ts';

/** What the serve runtime adds to a contract to make its manifest. */
export interface ManifestOptions {
  /** The system's version (its package version). */
  version: string;
  /** Hub events its implementation handles. */
  events?: readonly SystemEventType[];
  /** Whether its implementation serves resources. */
  resources?: boolean;
  client?: ClientAssets;
}

function handlersDecl(handlers: Handlers): Record<string, HandlerDecl> {
  return Object.fromEntries(entriesOf(handlers).map(([name, h]) => [name, {
    description: h.description, args: wireType(h.args), returns: wireType(h.returns), required: h.required,
  }]));
}

/** A fn declaration on the wire. `name` is local (`read`, `Entry.reveal`). */
export function fnDecl(name: string, def: AnyFnDef): FnDecl {
  const kind = def.kind === 'native' ? 'native' : def.kind.name;
  return {
    name,
    description: def.description,
    ...(def.instructions === undefined ? {} : { instructions: def.instructions }),
    kind,
    ...(def.kind === 'native' ? {} : { payload: encodeValue(def.kind.payload, def.payload) }),
    args: wireType(def.args),
    returns: wireType(def.returns),
    deps: Object.values(def.deps).map((dep) => dep.name),
    handlers: handlersDecl(def.handlers),
    progress: progressDecl(def.progress),
    ...(def.status === undefined ? {} : { status: def.status }),
    operations: { ...def.operations },
    ...(def.undo === undefined ? {} : { undo: wireType(def.undo) }),
    ...(def.resume === undefined ? {} : { resume: wireType(def.resume) }),
    ...(def.state === undefined ? {} : { state: wireType(def.state) }),
    ...(def.form === undefined ? {} : { form: wireType(def.form) }),
    display: def.display,
    limits: { ...def.limits },
    visibility: def.visibility,
    tags: [...def.tags],
    ...(def.examples.length === 0 ? {} : {
      examples: def.examples.map((example) => ({ args: encodeValue(def.args, example.args), ...(example.note === undefined ? {} : { note: example.note }) })),
    }),
    ...withValidation(validationOf(def.validate)),
    ...(def.approval === undefined ? {} : { approval: { ...def.approval } }),
  };
}

/** A fn's `validate` field, when it declares hooks. */
function withValidation(validate: FnDecl['validate']): Pick<FnDecl, 'validate'> {
  return validate === undefined ? {} : { validate };
}

/** What a context link points at, on the wire. */
function linkTarget(to: ContextLinkTarget): LinkTarget {
  if (!('ref' in to)) { return LinkTarget.parse({ kind: 'resource', uri: to.uri, ...(to.section === undefined ? {} : { section: to.section }) }); }
  switch (to.ref) {
    case 'context': return { kind: 'context', name: to.name };
    case 'fn': return { kind: 'fn', name: to.name };
    case 'type': return { kind: 'type', name: to.name };
  }
}

function typeDecl(name: string, def: AnyTypeDef): TypeDecl {
  return {
    name,
    description: def.description,
    def: wireType(def.shape),
    display: { ...def.display },
    methods: Object.keys(def.methods),
  };
}

function contextDecl(name: string, def: AnyContextDef): ContextDecl {
  return {
    name,
    description: def.description,
    ...(def.content === undefined ? {} : { content: def.content }),
    ...(def.command === undefined ? {} : {
      command: { name: def.command.name, args: entriesOf(def.command.args).map(([arg, a]) => ({ name: arg, hint: a.hint, required: a.required })) },
    }),
    imports: def.imports.map((c) => c.name),
    fns: def.fns.map((f) => f.name),
    suggestFns: def.suggestFns.map((f) => f.name),
    suggest: def.suggest,
    visible: def.visible,
    alwaysFor: def.alwaysFor.map((f) => f.name),
    tags: [...def.tags],
    ...(def.weight === undefined ? {} : { weight: def.weight }),
    ...(def.summary === undefined ? {} : { summary: def.summary }),
    ...(def.parent === undefined ? {} : { parent: def.parent.name }),
    ...(def.next === undefined ? {} : { next: def.next.name }),
    ...(def.links.length === 0 ? {} : {
      links: def.links.map((link) => DeclaredLink.parse({ to: linkTarget(link.to), relation: link.relation, ...(link.weight === undefined ? {} : { weight: link.weight }) })),
    }),
  };
}

/** Every qualified name a contract refers to that belongs to another system. */
function referencedSystems(system: string, defs: ContractShape): string[] {
  const names = new Set<QualifiedName>();
  for (const def of Object.values(defs.fns)) {
    for (const dep of Object.values(def.deps)) { names.add(dep.name); }
    if (def.kind !== 'native') { names.add(def.kind.name); }
  }
  for (const def of Object.values(defs.context)) {
    for (const ref of [...def.imports, ...def.fns, ...def.suggestFns, ...def.alwaysFor]) { names.add(ref.name); }
    for (const ref of [def.parent, def.next]) { if (ref !== undefined) { names.add(ref.name); } }
    for (const link of def.links) { if ('ref' in link.to) { names.add(link.to.name); } }
  }
  for (const def of Object.values(defs.mentions)) {
    if (def.of !== undefined) { names.add(def.of.name); }
  }
  for (const def of Object.values(defs.types)) {
    for (const ref of referencesOf(def.shape)) { names.add(ref); }
  }
  return [...new Set([...names].map((n) => splitName(n).system))].filter((s) => s !== system).sort();
}

/** The body of a manifest: everything but its hash. */
export function manifestBody(contract: AnyContract, options: ManifestOptions): Omit<Manifest, 'hash'> {
  const defs = contract.defs;
  const fns: FnDecl[] = entriesOf(defs.fns).map(([name, def]) => fnDecl(name, def));
  // a type's methods travel as fns named `Type.method` whose args hold the value as `self`
  for (const [typeName, def] of entriesOf(defs.types)) {
    const ref = contract.types[typeName];
    for (const [method, methodDef] of entriesOf(def.methods)) {
      const methodRef = ref?.methods[method];
      const decl = fnDecl(`${typeName}.${method}`, methodDef);
      fns.push(methodRef === undefined ? decl : { ...decl, args: wireType(methodRef.args) });
    }
  }
  const actions: ActionDecl[] = entriesOf(defs.actions).map(([name, def]) => ({
    name,
    description: def.description,
    input: wireType(def.input),
    returns: wireType(def.returns),
    ...(def.state === undefined ? {} : { state: wireType(def.state) }),
    ...(def.expires === undefined ? {} : { expires: def.expires }),
  }));
  return {
    name: SystemName.parse(contract.name),
    version: options.version,
    description: contract.description,
    types: entriesOf(defs.types).map(([name, def]) => typeDecl(name, def)),
    settings: entriesOf(defs.settings).map(([name, def]) => ({
      name, description: def.description, type: wireType(def.type), appliesTo: [...def.appliesTo], merge: def.merge, editableBy: [...def.editableBy],
    })),
    attachments: entriesOf(defs.attachments).map(([name, def]) => ({ name, description: def.description, data: wireType(def.data) })),
    kinds: entriesOf(defs.kinds).map(([name, def]) => ({
      name, description: def.description, applicability: def.applicability, payload: wireType(def.payload), approveChanges: def.approveChanges,
      ...(def.status === undefined ? {} : { status: def.status }),
    })),
    fns,
    context: entriesOf(defs.context).map(([name, def]) => contextDecl(name, def)),
    hooks: entriesOf(defs.hooks).map(([name, def]) => ({ name, description: def.description, order: def.order, timeout: def.timeout })),
    mentions: entriesOf(defs.mentions).map(([name, def]) => ({
      name, title: def.title, description: def.description, target: wireType(def.target), ...(def.of === undefined ? {} : { of: def.of.name }),
    })),
    embedders: entriesOf(defs.embedders).map(([name, def]) => ({ name, dimensions: def.dimensions, maxInput: def.maxInput, pricePerMillionTokens: def.pricePerMillionTokens })),
    sectioners: entriesOf(defs.sectioners).map(([name, def]) => ({ name, description: def.description, match: { ...def.match } })),
    actions,
    events: SYSTEM_EVENT_TYPES.filter((e) => options.events?.includes(e) ?? false),
    resources: options.resources ?? false,
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(defs.connect === undefined ? {} : { connect: connectDecl(contract.name, defs.connect, fns.map((f) => f.name)) }),
    ...(Object.keys(defs.providers).length === 0 ? {} : { providers: entriesOf(defs.providers).map(([name, def]) => providerDecl(name, def)) }),
    config: wireType(defs.config),
    requires: referencedSystems(contract.name, defs).map((s) => SystemName.parse(s)),
    ...(Object.keys(contract.registries).length === 0 ? {} : {
      registries: entriesOf(contract.registries).map(([name, def]) => ({ name, description: def.description, data: wireType(def.data) })),
    }),
    ...(contract.contributes.length === 0 ? {} : { contributes: contract.contributes.map((c) => ({ ...c })) }),
    ...(contract.configSecrets.length === 0 ? {} : { configSecrets: checkedSecrets(contract.name, wireType(defs.config), contract.configSecrets) }),
  };
}

/** The config's secret paths, checked: each must name a text field (optional or nullable allowed) of the config type. */
export function checkedSecrets(system: string, config: GinTypeDef, paths: readonly string[]): string[] {
  for (const path of paths) {
    let at: GinTypeDef | undefined = config;
    for (const key of path.split('.')) { at = at === undefined ? undefined : unwrapped(at).props?.[key]?.type; }
    if (at === undefined || unwrapped(at).name !== 'text') {
      throw new Error(`system ${system}: config secret '${path}' must be a text field of the config.`);
    }
  }
  return [...paths];
}

/** A type def without its `optional` / `nullable` wrappers. */
function unwrapped(def: GinTypeDef): GinTypeDef {
  let at = def;
  while ((at.name === 'optional' || at.name === 'nullable') && at.generic?.['T'] !== undefined) { at = at.generic['T']; }
  return at;
}

/** A `connect` declaration, checked: every fn it switches must be one of the system's fns. */
function connectDecl(system: string, decl: ConnectDecl, fns: readonly string[]): ConnectDecl {
  const unknown = Object.keys(decl.fns).filter((name) => !fns.includes(name));
  if (unknown.length > 0) { throw new Error(`system ${system}: connect names fns it doesn't declare: ${unknown.join(', ')}`); }
  return decl;
}

/** JSON with object keys sorted, so equal content always hashes the same. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(',')}]`; }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The sha-256 of a string, hex. Web Crypto, so it works in Node and the browser. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A contract's manifest, hashed and checked against core's `Manifest` schema. */
export async function manifestOf(contract: AnyContract, options: ManifestOptions): Promise<Manifest> {
  const body = manifestBody(contract, options);
  const hash = await sha256(canonicalJson(Json.parse(body)));
  return Manifest.parse({ ...body, hash });
}
