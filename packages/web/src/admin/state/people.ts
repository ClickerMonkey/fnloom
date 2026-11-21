/**
 * SSO's People pages: people and groups (lists the hub searches, filters and pages, `users` and `groups`), the person
 * or group open beside its list, and the Sign-in tab (the providers from the hub's env, read-only, each with a check;
 * the first-sign-in policy; a test sign-in and its result). Writes go through one `Task`, so the open dialog shows the
 * hub's refusal, and refresh what is shown.
 */
import type {
  ActorId, GroupView, ListQuery, PersonView, ProxyTrust, SetMembership, SignInLimits, SignInPolicy, SignInSettings, SsoCheck, SsoProviderId, SsoTestResult, UpdateUser, UserRole, UserView,
} from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded, Paged, Task, type Outcome, type Page } from '../../state/loaded.ts';
import { withPage } from '../../state/query.ts';
import type { AdminApi } from '../api.ts';
import { BROWSER_PAGE } from './browsers.ts';

/** The callers the People pages use. */
export type PeopleApi = Pick<AdminApi,
  'people' | 'groups' | 'groupMembers' | 'addUser' | 'addGroup' | 'updateUser' | 'setMembership' | 'signInSettings' | 'setSignInPolicy' | 'setSignInLimits' | 'setProxyTrust' | 'checkSsoProvider' | 'testSsoSignIn' | 'ssoTestResult'>;

/** A person to add. */
export interface NewPerson {
  readonly name: string;
  readonly email: string;
  readonly role: UserRole;
  readonly groups?: readonly ActorId[];
}

/** A group and the first page of its members. */
export type GroupMembers = Page<UserView> & { readonly group: GroupView };

/** People, groups and sign-in. */
export class PeopleStore {
  readonly #api: PeopleApi;
  readonly users: Paged<PersonView, ListQuery>;
  readonly groups: Paged<GroupView, ListQuery>;
  /** The person open beside the list (by email, as the URL names them); undefined when nobody has it. */
  readonly person = new Loaded<PersonView | undefined>();
  /** The group open beside its list, and its members. */
  readonly members = new Loaded<GroupMembers>();
  readonly signIn = new Loaded<SignInSettings>();
  /** The last check of each provider. */
  readonly checks = shallowRef<ReadonlyMap<SsoProviderId, SsoCheck>>(new Map());
  /** The provider being checked now. */
  readonly checking = shallowRef<SsoProviderId | undefined>(undefined);
  /** The test sign-in in the URL. */
  readonly test = new Loaded<SsoTestResult>();
  readonly save = new Task();

  constructor(api: PeopleApi) {
    this.#api = api;
    this.users = new Paged({
      fetch: (query, cursor, limit) => api.people.call(withPage<ListQuery>(query, limit, cursor)),
      key: (person) => person.id, failure: 'Couldn’t load the people.', limit: BROWSER_PAGE,
    }, {});
    this.groups = new Paged({
      fetch: (query, cursor, limit) => api.groups.call(withPage<ListQuery>(query, limit, cursor)),
      key: (group) => group.id, failure: 'Couldn’t load the groups.', limit: BROWSER_PAGE,
    }, {});
  }

  /** Open the person with this email (quietly after a change). */
  openPerson(email: string, quiet = false): Promise<void> {
    return this.person.load(async () => (await this.#api.people.call({ filters: [{ field: 'email', op: 'is', value: email }], limit: 1 })).items[0], 'Couldn’t load them.', quiet);
  }

  /** Open a group with its first 200 members (a group is browsed, not exported). */
  openGroup(group: ActorId, quiet = false): Promise<void> {
    return this.members.load(() => this.#api.groupMembers.call({ group, limit: 200 }), 'Couldn’t load the group.', quiet);
  }

  /** The Sign-in tab's settings (quietly in the background). */
  loadSignIn(quiet = false): Promise<void> {
    return this.signIn.load(() => this.#api.signInSettings.call({}), 'Couldn’t load how people sign in.', quiet);
  }

  /** A test sign-in's result. */
  loadTest(test: string): Promise<void> {
    return this.test.load(() => this.#api.ssoTestResult.call({ test }), 'Couldn’t read the test sign-in.');
  }

  /** Reach a provider's discovery document and key set now. */
  async check(provider: SsoProviderId): Promise<void> {
    this.checking.value = provider;
    try {
      const check = await this.#api.checkSsoProvider.call({ provider });
      this.checks.value = new Map([...this.checks.value, [provider, check]]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.checks.value = new Map([...this.checks.value, [provider, { provider, ok: false, discovery: { ok: false, detail }, keys: { ok: false, detail: 'Not checked.' }, checkedAt: Date.now() }]]);
    } finally {
      this.checking.value = undefined;
    }
  }

  /** Start a test sign-in: the provider's URL to go to (the hub set the cookie that brings the result back here). */
  startTest(provider: SsoProviderId): Promise<Outcome<{ url: string; test: string }>> {
    return this.save.run(() => this.#api.testSsoSignIn.call({ provider }), 'Couldn’t start the test sign-in.');
  }

  addPerson(person: NewPerson): Promise<Outcome<{ id: ActorId }>> {
    const body = { name: person.name, email: person.email, role: person.role, ...(person.groups === undefined ? {} : { groups: [...person.groups] }) };
    return this.#changed(this.save.run(() => this.#api.addUser.call(body), 'Couldn’t add them.'));
  }

  addGroup(group: { readonly name: string; readonly about: string }): Promise<Outcome<{ id: ActorId }>> {
    return this.#changed(this.save.run(() => this.#api.addGroup.call(group), 'Couldn’t add the group.'));
  }

  update(change: UpdateUser): Promise<Outcome<{ id: ActorId }>> {
    return this.#changed(this.save.run(() => this.#api.updateUser.call(change), 'Couldn’t change them.'));
  }

  membership(change: SetMembership): Promise<Outcome<{ ok: boolean }>> {
    return this.#changed(this.save.run(() => this.#api.setMembership.call(change), 'Couldn’t change the group.'));
  }

  async setPolicy(policy: SignInPolicy): Promise<Outcome<SignInPolicy>> {
    const done = await this.save.run(() => this.#api.setSignInPolicy.call(policy), 'Couldn’t save who can join.');
    if (done.ok) void this.loadSignIn(true);
    return done;
  }

  /** How many password sign-ins the hub takes. */
  async setLimits(limits: SignInLimits): Promise<Outcome<SignInLimits>> {
    const done = await this.save.run(() => this.#api.setSignInLimits.call(limits), 'Couldn’t save the sign-in limits.');
    if (done.ok) void this.loadSignIn(true);
    return done;
  }

  /** How many proxies in front of the hub say where requests come from. */
  async setProxy(trust: ProxyTrust): Promise<Outcome<ProxyTrust>> {
    const done = await this.save.run(() => this.#api.setProxyTrust.call(trust), 'Couldn’t save the proxy setting.');
    if (done.ok) void this.loadSignIn(true);
    return done;
  }

  /** After a change: the lists and whatever is open, again, quietly. */
  async #changed<R>(work: Promise<Outcome<R>>): Promise<Outcome<R>> {
    const done = await work;
    if (!done.ok) return done;
    void this.users.refresh();
    void this.groups.refresh();
    const person = this.person.value.value;
    if (person !== undefined) void this.openPerson(person.email, true);
    const group = this.members.value.value?.group;
    if (group !== undefined) void this.openGroup(group.id, true);
    return done;
  }
}
