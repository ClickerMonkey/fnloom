import { describe, expect, it } from 'vitest';
import { faviconHref, faviconSvg, showFavicon } from '../app/favicon.ts';
import { failingCaller, fakeApi, fakePush } from '../test/fakes.ts';
import { OPEN_KEY, PushPayload, pushOpenPath } from './push-payload.ts';
import { PushStore } from './push.ts';

describe('PushStore', () => {
  it('subscribes this device and tells the hub, then turns off again', async () => {
    const api = fakeApi().notifications;
    const platform = fakePush();
    const push = new PushStore(api, platform, () => 'Test browser');
    await push.check();
    expect(push.state.value).toBe('off');
    expect(await push.enable()).toBe(true);
    expect(push.state.value).toBe('on');
    expect(api.subscribePush.calls[0]?.[0]).toEqual({ endpoint: 'https://push.example/BPub_key-1', keys: { p256dh: 'p', auth: 'a' }, device: 'Test browser' });
    await push.check();
    expect(push.state.value).toBe('on');
    await push.disable();
    expect(push.state.value).toBe('off');
  });

  it('says when the browser cannot, when the person says no, and when the hub refuses', async () => {
    const api = fakeApi().notifications;
    const unsupported = new PushStore(api, fakePush({ supported: false }), () => 'x');
    await unsupported.check();
    expect(unsupported.state.value).toBe('unsupported');
    expect(await unsupported.enable()).toBe(false);

    const refused = new PushStore(api, fakePush({ answer: 'denied' }), () => 'x');
    expect(await refused.enable()).toBe(false);
    expect(refused.state.value).toBe('blocked');
    await refused.check();
    expect(refused.state.value).toBe('blocked');

    const failing = new PushStore({ ...api, subscribePush: failingCaller<'subscribePush'>(new Error('down')) }, fakePush(), () => 'x');
    expect(await failing.enable()).toBe(false);
    expect(failing.problem.value).not.toBe('');
    expect(failing.busy.value).toBe(false);
  });

  it('reads a push as the notification it carries, and opens it in the inbox', () => {
    const payload = PushPayload.parse({ id: 'ntf_1', title: 'Approve fs/bash?', body: 'A run waits.', link: { run: 'run_1' }, reason: 'approval-needed' });
    expect(pushOpenPath(payload)).toBe(`/inbox?${OPEN_KEY}=ntf_1`);
    expect(PushPayload.safeParse({ title: 'no id' }).success).toBe(false);
  });
});

describe('favicon', () => {
  it('draws the mark, with a dot when something needs you', () => {
    expect(faviconSvg(true)).toContain('<circle cx="26"');
    expect(faviconSvg(false)).not.toContain('<circle cx="26"');
    expect(faviconHref(false).startsWith('data:image/svg+xml,')).toBe(true);
    showFavicon(document, true);
    showFavicon(document, false);
    const icons = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.href).toBe(faviconHref(false));
  });
});
