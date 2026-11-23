/**
 * System pages (item 9): the contract's `pages` (checked in `system()`), `client({ pages })` checked against them, the
 * manifest carrying them, and the runtime mounting a page with its host and its system's client.
 */
import { client as apiClient } from '@ayepi/core/client';
import { hubWebSpec, Manifest, mintId, type HubWebSpec, type UserView } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { h, type Component } from 'vue';
import { client, type PageHost, type PageViewOf, type SharedComponents } from './client.ts';
import { ClientRuntime, type ClientBridge } from './client-runtime.ts';
import { action } from './declare.ts';
import { g } from './gin.ts';
import { manifestBody } from './manifest.ts';
import { system } from './system.ts';

const crew = system('crew', {
  description: 'A crew.',
  pages: [
    { segment: 'roster', title: 'Crew', icon: 'users', component: 'RosterPage' },
    { segment: 'member', title: 'Crew member', nav: 'hidden', access: 'admin', component: 'MemberPage' },
  ],
}).with({ actions: { ping: action({ description: 'Ping.', input: g.obj({}), returns: g.bool() }) } });

const RosterPage = (view: PageViewOf<typeof crew>) => h('div', view.host.query.get('q') ?? '');
const MemberPage = (view: PageViewOf<typeof crew>) => h('div', view.path.join('/'));

const bridge: ClientBridge = {
  online: () => true,
  act: () => Promise.resolve(mintId('delivery')),
  submit: () => Promise.resolve(mintId('delivery')),
  invoke: () => Promise.resolve(mintId('run')),
  follow: () => Promise.resolve(true),
};

/** The app's shared components as stand-ins: the runtime only passes them through. */
const STAND_IN: Component = { render: () => null };
const STAND_INS: SharedComponents = {
  Frame: STAND_IN, Input: STAND_IN, Markdown: STAND_IN, Icon: STAND_IN, Empty: STAND_IN, LoadState: STAND_IN, Reasoning: STAND_IN, Typing: STAND_IN,
  ResourceViewer: STAND_IN, ValueEditor: STAND_IN, Button: STAND_IN, Select: STAND_IN, Textarea: STAND_IN, Dialog: STAND_IN, Banner: STAND_IN,
  Badge: STAND_IN, Skeleton: STAND_IN, FnPill: STAND_IN, Approval: STAND_IN, Conversation: STAND_IN, Composer: STAND_IN,
};

/** A host as the app would make one; only what the runtime passes through matters here. */
function host(): PageHost {
  const user: UserView = { id: mintId('actor'), kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'admin' };
  return {
    user,
    hub: apiClient<HubWebSpec>({ baseUrl: 'http://hub.test/api', manifest: hubWebSpec, fetchImpl: () => Promise.reject(new Error('no hub here')) }),
    query: { values: { q: 'ada' }, get: (key) => (key === 'q' ? 'ada' : undefined), set: () => undefined, bind: () => ({ value: '' }) },
    href: () => '/s/crew/roster',
    go: () => undefined,
    openChat: () => Promise.resolve(),
    chatHref: () => '/c/ses_1',
    goChat: () => undefined,
    runHref: (run) => `/run/${run}`,
    goRun: () => undefined,
    components: STAND_INS,
    runs: () => { throw new Error('no runs here'); },
    inbox: { byRun: () => undefined, load: () => Promise.resolve(), decide: () => Promise.resolve(false), problem: '' },
    notify: { ok: () => undefined, error: () => undefined },
    format: { cost: (usd) => `$${usd}`, relativeTime: () => 'now', fullTime: () => '' },
    live: () => undefined,
  };
}

describe('system pages: the contract', () => {
  it('fills in nav and access, and refuses a segment declared twice or one that is not a URL segment', () => {
    expect(crew.pages[0]).toMatchObject({ segment: 'roster', nav: 'main', access: 'everyone' });
    expect(crew.pages[1]).toMatchObject({ segment: 'member', nav: 'hidden', access: 'admin' });
    expect(() => system('twice', { description: 'Twice.', pages: [{ segment: 'a', title: 'A', component: 'A' }, { segment: 'a', title: 'B', component: 'B' }] }))
      .toThrow(/page a is declared twice/u);
    expect(() => system('bad', { description: 'Bad.', pages: [{ segment: 'Not/A/Segment', title: 'Bad', component: 'Bad' }] })).toThrow(/segment/u);
  });

  it('puts the pages on the manifest, which the hub reads back', () => {
    const body = manifestBody(crew, { version: '1.0.0' });
    expect(body.pages?.map((page) => page.segment)).toEqual(['roster', 'member']);
    expect(Manifest.shape.pages.parse(body.pages)).toEqual(body.pages);
    // a manifest not made by system() is held to the same rule: no segment twice
    expect(Manifest.shape.pages.safeParse([...(body.pages ?? []), body.pages?.[0]]).error?.issues[0]?.message).toBe('page roster is declared twice');
    expect(manifestBody(system('plain', { description: 'Plain.' }), { version: '1.0.0' }).pages).toBeUndefined();
  });
});

describe('system pages: client()', () => {
  it('needs a component for every declared page', () => {
    expect(() => client(crew, { pages: { RosterPage } })).toThrow(/page member names component MemberPage, which client\(\{ pages \}\) doesn't have/u);
  });

  it('refuses a page component no page names', () => {
    expect(() => client(crew, { pages: { RosterPage, MemberPage, Stray: RosterPage } })).toThrow(/page component Stray is not named/u);
  });

  it('accepts the pages when every one has its component', () => {
    expect(client(crew, { pages: { RosterPage, MemberPage } }).renderers.pages).toEqual({ RosterPage, MemberPage });
  });
});

describe('system pages: the runtime', () => {
  it('lists a loaded system’s pages and mounts one with the host, the path under it and the system’s client', () => {
    const runtime = new ClientRuntime(bridge);
    expect(runtime.pages('crew')).toEqual([]);
    runtime.register(client(crew, { pages: { RosterPage, MemberPage } }));
    expect(runtime.pages('crew').map((page) => page.segment)).toEqual(['roster', 'member']);
    const given = host();
    const mount = runtime.pageView('crew', 'member', { path: ['main', 'abc'], host: given });
    expect(mount?.component).toBe(MemberPage);
    expect(mount?.props.page).toBe('member');
    expect(mount?.props.path).toEqual(['main', 'abc']);
    expect(mount?.props.host).toBe(given);
    expect(mount?.props.system).toBe(runtime.systemClient('crew'));
    expect(Object.keys(mount?.props.system.send ?? {})).toEqual(['ping']);
  });

  it('mounts nothing for a page the system does not declare, or a system that is not loaded', () => {
    const runtime = new ClientRuntime(bridge);
    runtime.register(client(crew, { pages: { RosterPage, MemberPage } }));
    expect(runtime.pageView('crew', 'gone', { path: [], host: host() })).toBeUndefined();
    expect(runtime.pageView('other', 'roster', { path: [], host: host() })).toBeUndefined();
  });

  it('drops the old pages when a newer build of the system registers', () => {
    const runtime = new ClientRuntime(bridge);
    runtime.register(client(crew, { pages: { RosterPage, MemberPage } }));
    const slimmer = system('crew', { description: 'A crew.', pages: [{ segment: 'roster', title: 'Crew', component: 'RosterPage' }] });
    const SlimRoster = (view: PageViewOf<typeof slimmer>) => h('div', view.page);
    runtime.register(client(slimmer, { pages: { RosterPage: SlimRoster } }));
    expect(runtime.pages('crew').map((page) => page.segment)).toEqual(['roster']);
    expect(runtime.pageView('crew', 'member', { path: [], host: host() })).toBeUndefined();
  });
});
