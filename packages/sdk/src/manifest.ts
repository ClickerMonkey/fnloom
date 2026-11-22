/**
 * The manifest: a contract as JSON, the way the hub receives it. Built from the typed contract, so the two can't
 * disagree, and checked against core's `Manifest` schema before it leaves.
 */
import {
  fnLocalNameProblem, owesExamples, DeclaredLink, InjectDecl, GENERAL_GROUP, Json, LinkTarget, Manifest, SystemName, splitName, SYSTEM_EVENT_TYPES,
  type ActionDecl, type ClientAssets, type ConnectDecl, type ContextDecl, type FnDecl, type HandlerDecl, type QualifiedName, type SystemEventType,
  type TypeDecl, type ApiGroupDecl, GinTypeDef, RecordType,
} from '@harness/core';
import { z } from 'zod';
import type { AnyContextDef, AnyTypeDef, ContextLinkTarget, InjectInput } from './declare.ts';
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
      examples: def.examples.map((example) => ({
        args: encodeValue(def.args, example.args),
        ...(example.result === undefined ? {} : { result: encodeValue(def.returns, example.result) }),
        ...(example.note === undefined ? {} : { note: example.note }),
      })),
    }),
    ...withValidation(validationOf(def.validate)),
    ...(def.approval === undefined ? {} : { approval: { ...def.approval } }),
    ...(def.routing === undefined ? {} : { routing: def.routing }),
    ...(def.connectKey === undefined ? {} : { connectKey: def.connectKey }),
    ...(def.effects === undefined ? {} : { effects: def.effects }),
    ...(def.promptExamples === undefined ? {} : { promptExamples: def.promptExamples }),
    ...(def.group === undefined ? {} : { group: def.group }),
    ...(def.flags ? { flags: true } : {}),
    ...(def.roles === undefined || def.roles.length === 0 ? {} : { roles: [...def.roles] }),
    ...(def.parallelClaims.length === 0 ? {} : { parallelClaims: [...def.parallelClaims] }),
    ...(def.dynamicClaims ? { dynamicClaims: true } : {}),
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
    ...(def.records === undefined ? {} : { records: { ...def.records, search: { ...def.records.search, text: [...def.records.search.text] } } }),
  };
}

function contextDecl(name: string, def: AnyContextDef): ContextDecl {
  return {
    name,
    ...(def.title === undefined ? {} : { title: def.title }),
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
    ...(def.inject === undefined ? {} : { inject: injectDecl(def.inject) }),
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

/** An injection on the wire: refs as their qualified names, patterns as written, the defaults filled in. */
function injectDecl(inject: InjectInput): InjectDecl {
  return InjectDecl.parse({
    into: inject.into.map((target) => (typeof target === 'string' ? target : target.name)),
    order: inject.order ?? 100,
    requires: (inject.requires ?? []).map((ref) => ref.name),
    ...(inject.mode === undefined ? {} : { mode: inject.mode }),
  });
}

/** Every qualified name a contract refers to that belongs to another system. */
function referencedSystems(system: string, defs: ContractShape): string[] {
  const names = new Set<QualifiedName>();
  for (const def of Object.values(defs.fns)) {
    for (const dep of Object.values(def.deps)) { names.add(dep.name); }
    if (def.kind !== 'native') { names.add(def.kind.name); }
  }
  for (const def of Object.values(defs.context)) {
    for (const ref of [...def.imports, ...def.fns, ...def.suggestFns, ...(def.inject?.requires ?? [])]) { names.add(ref.name); }
    for (const target of def.inject?.into ?? []) { if (typeof target !== 'string') { names.add(target.name); } }
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
    ...(contract.about === undefined ? {} : { about: contract.about }),
    types: entriesOf(defs.types).map(([name, def]) => typeDecl(name, def)),
    settings: entriesOf(defs.settings).map(([name, def]) => ({
      name, description: def.description, type: wireType(def.type), appliesTo: [...def.appliesTo], merge: def.merge, editableBy: [...def.editableBy],
    })),
    attachments: entriesOf(defs.attachments).map(([name, def]) => ({ name, description: def.description, data: wireType(def.data) })),
    kinds: entriesOf(defs.kinds).map(([name, def]) => ({
      name, description: def.description, applicability: def.applicability, payload: wireType(def.payload), approveChanges: def.approveChanges,
      ...(def.status === undefined ? {} : { status: def.status }),
      ...(def.estimates ? { estimates: true } : {}),
    })),
    fns: checkedFnNames(contract.name, fns),
    context: entriesOf(defs.context).map(([name, def]) => contextDecl(name, def)),
    hooks: entriesOf(defs.hooks).map(([name, def]) => ({ name, description: def.description, ...(def.explains === undefined ? {} : { explains: def.explains }), order: def.order, timeout: def.timeout })),
    mentions: entriesOf(defs.mentions).map(([name, def]) => ({
      name, title: def.title, description: def.description, target: wireType(def.target), ...(def.of === undefined ? {} : { of: def.of.name }),
    })),
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
    ...(contract.grants === undefined ? {} : { grants: contract.grants }),
    ...(contract.configComponent === undefined ? {} : { configComponent: contract.configComponent }),
    ...(contract.pages.length === 0 ? {} : { pages: contract.pages.map((page) => ({ ...page })) }),
    ...(contract.groups.length === 0 ? {} : { groups: checkedGroups(contract.name, contract.groups, fns) }),
  };
}

/** The API groups, checked: names are unique and every group a fn names is declared (a fn with none is general). */
function checkedGroups(system: string, groups: readonly ApiGroupDecl[], fns: readonly FnDecl[]): ApiGroupDecl[] {
  const names = new Set<string>();
  for (const group of groups) {
    if (names.has(group.name)) { throw new Error(`system ${system}: API group ${group.name} is declared twice.`); }
    names.add(group.name);
  }
  for (const fn of fns) {
    if (fn.group !== undefined && fn.group !== GENERAL_GROUP && !names.has(fn.group)) {
      throw new Error(`system ${system}: fn ${fn.name} is in API group ${fn.group}, which system(${JSON.stringify(system)}, { groups }) does not declare.`);
    }
  }
  return groups.map((group) => ({ ...group }));
}

/**
 * The config's secret paths, checked: each must name a text field of the config type, or a record of text (`record<text>`,
 * how a record over open keys is read, such as environment or header values, which the hub seals whole), or an `any`
 * one; optional or nullable allowed.
 */
export function checkedSecrets(system: string, config: GinTypeDef, paths: readonly string[]): string[] {
  for (const path of paths) {
    let at: GinTypeDef[] = [config];
    for (const key of path.split('.')) { at = at.flatMap(variantsOf).flatMap((def) => { const type = def.props?.[key]?.type; return type === undefined ? [] : [type]; }); }
    if (at.length === 0 || !at.flatMap(variantsOf).every((def) => def.name === 'text' || def.name === 'any' || (def.name === RecordType.NAME && def.generic?.['V'] !== undefined && variantsOf(def.generic['V']).every((value) => value.name === 'text')))) {
      throw new Error(`system ${system}: config secret '${path}' must be a text field (or a record of text) of the config.`);
    }
  }
  return [...paths];
}

/** A type def's shapes: itself without `optional` / `nullable` wrappers, or each option of a union (a field one kind of config has). */
function variantsOf(def: GinTypeDef): GinTypeDef[] {
  const at = unwrapped(def);
  if (at.name !== 'or') { return [at]; }
  const options = OrOptions.safeParse(at.options);
  return options.success ? options.data.types.flatMap(variantsOf) : [];
}

/** A union's options as gin writes them (`{ types }`). */
const OrOptions = z.object({ types: z.array(GinTypeDef) });

/** A type def without its `optional` / `nullable` wrappers. */
function unwrapped(def: GinTypeDef): GinTypeDef {
  let at = def;
  while ((at.name === 'optional' || at.name === 'nullable') && at.generic?.['T'] !== undefined) { at = at.generic['T']; }
  return at;
}

/**
 * A contract's fns, checked: every fn's local name must carry its model name (core's `FnLocalName`: no `__`, no part
 * starting or ending with `_`), so the name the model calls it by reads back. The build refuses one that doesn't.
 */
function checkedFnNames(system: string, fns: FnDecl[]): FnDecl[] {
  const problems = fns.flatMap((decl) => { const problem = fnLocalNameProblem(decl.name); return problem === undefined ? [] : [problem]; });
  if (problems.length > 0) { throw new Error(`system ${system}: ${problems.join('; ')}`); }
  return fns;
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

/**
 * The hash an approved install binds its pairing grant to (`Hello.contractHash`): the manifest's contract parts, the same
 * whether worked out from the contract alone (fs's build, before anything runs) or by the running system. What only the
 * process adds is left out: its client assets, the events its implementation handles, whether it serves resources, and
 * its context, which may come from its context folder (all inside the approved bundle, whose hash fs checks).
 */
export async function contractHash(manifest: Manifest): Promise<string> {
  const { hash: _hash, client: _client, events: _events, resources: _resources, context: _context, ...contract } = manifest;
  return sha256(canonicalJson(Json.parse(contract)));
}

/** A contract's manifest, hashed and checked against core's `Manifest` schema. */
export async function manifestOf(contract: AnyContract, options: ManifestOptions): Promise<Manifest> {
  const body = manifestBody(contract, options);
  const hash = await sha256(canonicalJson(Json.parse(body)));
  return Manifest.parse({ ...body, hash });
}

/** The fns among these whose author must write an example and wrote none (`owesExamples`), by their local names. */
export function fnsMissingExamples(fns: readonly Pick<FnDecl, 'name' | 'kind' | 'examples'>[]): string[] {
  return fns.filter(owesExamples).map((decl) => decl.name);
}

/** A contract with static fns that declare no example: the build and `serve` refuse it, naming each. */
export class MissingExamplesError extends Error {
  override readonly name = 'MissingExamplesError';
  readonly system: string;
  readonly fns: readonly string[];

  constructor(system: string, fns: readonly string[]) {
    super(`system ${system}: every fn needs at least one example, and ${fns.join(', ')} ${fns.length === 1 ? 'has' : 'have'} none. Add \`examples: [{ args: {...}, note: '...' }]\` to ${fns.length === 1 ? 'it' : 'each'} (the args of its own args type, a note saying what it shows).`);
    this.system = system;
    this.fns = fns;
  }
}

/** Refuse a contract whose static fns (native fns, type methods and agents) include one with no example. */
export function checkExamples(contract: AnyContract): void {
  const missing = fnsMissingExamples(manifestBody(contract, { version: '0.0.0' }).fns);
  if (missing.length > 0) { throw new MissingExamplesError(contract.name, missing); }
}
