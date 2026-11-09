/** Build 5's admin side: what a fleet instance owns (a database's types and saved queries), its proposed changes, and secret config fields. */
import { InstanceName, SECRET_KEPT, SystemName, type Approval } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { approval, run } from '../chat/test/fakes.ts';
import GinForm from '../gin/GinForm.vue';
import { fakeCaller } from '../test/fakes.ts';
import { changedTypes, instanceFns, keptSecrets, typeNamesOf } from './logic/instances.ts';
import { InstancePartsStore } from './state/instance-parts.ts';
import { fnRecord } from './test/fakes.ts';

const DATABASE = SystemName.parse('database');
const SHOP = InstanceName.parse('shop');
const query = (local: string, instance: string, deps: readonly `${string}/${string}`[]) => fnRecord({
  name: `database/${instance}.${local}`, system: 'database', origin: 'runtime',
  decl: { ...fnRecord().decl, name: `${instance}.${local}`, kind: 'database/query', deps: [...deps], routing: { to: 'instance', instance } },
});
const diff = (name: string): Approval => approval({
  run: 'run_rescan', proposed: true,
  preview: { title: 'Apply', irreversible: true, parts: [{ type: 'type-diff', name, before: { name: 'text' }, after: { name: 'num' }, changes: ['Changes it'], breaks: [] }] },
});

describe('instance parts', () => {
  it('keeps the fns routed to the instance and asks for the types they and its waiting changes name', () => {
    const fns = [query('a', 'shop', ['database/shop.Orders', 'fs/read']), query('b', 'main', ['database/main.Users']), fnRecord({ name: 'database/get_query', system: 'database' })];
    const mine = instanceFns(fns, SHOP);
    expect(mine.map((fn) => fn.name)).toEqual(['database/shop.a']);
    expect(typeNamesOf(DATABASE, mine, [diff('shop.Items')])).toEqual(['database/shop.Items', 'database/shop.Orders']);
    expect([...changedTypes(DATABASE, [diff('database/shop.Orders')])]).toEqual(['database/shop.Orders']);
  });

  it('finds the set secret fields of a config', () => {
    expect(keptSecrets({ label: 'Shop', connection: { kind: 'postgres', url: SECRET_KEPT, password: 'typed' } })).toEqual(['connection.url']);
    expect(keptSecrets(SECRET_KEPT)).toEqual([]);
  });

  it('shows only proposed changes of the instance, and reads it again once one is answered', async () => {
    const proposed = diff('shop.Orders');
    const api = {
      systemFns: fakeCaller<'systemFns'>(() => Promise.resolve([query('a', 'shop', ['database/shop.Orders'])])),
      runs: fakeCaller<'runs'>(() => Promise.resolve({
        items: [
          run({ id: 'run_rescan', system: 'database', instance: 'shop', status: 'awaiting-approval' }),
          run({ id: 'run_write', system: 'database', instance: 'shop', status: 'awaiting-approval' }),
          run({ id: 'run_other', system: 'database', instance: 'main', status: 'awaiting-approval' }),
        ],
      })),
    };
    const chat = {
      types: fakeCaller<'types'>(({ names }) => Promise.resolve({ types: [], missing: names })),
      approvals: fakeCaller<'approvals'>(() => Promise.resolve([proposed, approval({ id: 'apr_write', run: 'run_write' })])),
      approve: fakeCaller<'approve'>(() => Promise.resolve({ ...proposed, status: 'approved' })),
    };
    const store = new InstancePartsStore(api, chat);
    await store.open({ system: DATABASE, instance: SHOP });
    expect(chat.approvals.calls[0]?.[0]).toEqual({ runs: ['run_rescan', 'run_write'] });
    expect(store.proposals.value.map((a) => a.id)).toEqual([proposed.id]);
    expect([...store.changing.value]).toEqual(['database/shop.Orders']);
    expect(chat.types.calls[0]?.[0]).toEqual({ names: ['database/shop.Orders'] });
    expect(await store.decide(proposed, true, '')).toBe(true);
    expect(chat.approve.calls[0]?.[0]).toMatchObject({ approval: proposed.id, approve: true, remember: 'once' });
    await flushPromises();
    expect(api.runs.calls).toHaveLength(2);
  });
});

describe('secret config fields', () => {
  it('draws a kept secret as an empty password input reading "Saved", and keeps it unless typed over', async () => {
    const type = { name: 'obj', props: { url: { type: { name: 'text' } }, label: { type: { name: 'text' } } } };
    const form = mount(GinForm, { props: { type, initial: { url: SECRET_KEPT, label: 'Shop' }, secrets: ['url'] }, attachTo: document.body });
    const secret = form.find('[data-path="url"] input');
    expect(secret.attributes('type')).toBe('password');
    expect(secret.element instanceof HTMLInputElement && secret.element.value).toBe('');
    expect(secret.attributes('placeholder')).toBe('Saved');
    expect(form.find('[data-path="label"] input').attributes('type')).toBe('text');
    await form.find('form').trigger('submit');
    expect(form.emitted('submit')?.[0]).toEqual([{ url: SECRET_KEPT, label: 'Shop' }]);
    await secret.setValue('postgres://new');
    await form.find('form').trigger('submit');
    expect(form.emitted('submit')?.[1]).toEqual([{ url: 'postgres://new', label: 'Shop' }]);
    form.unmount();
  });
});
