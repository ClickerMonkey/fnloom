/** A/B compare through the web API: the real plugins and sign-in, with the chat module faked to see what reaches it. */
import { type ActorId, mintId, QualifiedName, SessionId, TurnId, type CompareView, type Session } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

const sessionId = SessionId.parse('ses_1');
const turn = TurnId.parse('trn_cmp');
const client = { timeZone: 'Europe/Paris', locale: 'fr', now: 1 };
const variants = [{ label: 'Fast', settings: { model: { model: 'fast-1' } } }, { settings: { instructions: 'Be brief.' } }];

function session(owner: ActorId): Session {
  return {
    id: sessionId, title: 'Plans', owner, agent: QualifiedName.parse('hub/chat'), participants: [], systems: 'all', tools: [], context: [], status: 'idle',
    transcript: [], createdAt: 1, updatedAt: 1, archived: false,
  };
}

const view = (session: SessionId): CompareView => ({ turn, session, message: mintId('message'), status: 'running', reserved: 0.5, discarded: [], variants: [] });

async function signedIn(fakes: Fakes) {
  const r = await rig({ ...fakes, index: { ...fakes.index, embedders: { active: () => undefined, ...fakes.index?.embedders } } });
  const web = await webRig(r);
  const tokens = await web.admin();
  return { r, web, as: web.as(tokens), me: tokens.user.id };
}

describe('the compare endpoints', () => {
  it('sends a compare as the signed-in author with its variants, and refuses a chat they may not see', async () => {
    const sends: unknown[] = [];
    const { web, as, me } = await signedIn({
      chat: {
        sessions: { get: (id, viewer) => Promise.resolve(id === sessionId ? session(viewer) : undefined) },
        turns: {
          send: (input) => {
            sends.push(input);
            return Promise.resolve({ turn, message: { id: mintId('message'), session: input.session, turn, author: input.author, role: 'user', parts: [], runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 1, compared: true } });
          },
        },
      },
    });
    const sent = await web.client.call('compare', { session: sessionId, parts: [{ type: 'text', text: 'Which?' }], variants, client }, as);
    expect(sent).toMatchObject({ turn, message: { compared: true } });
    expect(sends).toEqual([{ session: sessionId, parts: [{ type: 'text', text: 'Which?' }], variants, client, author: me }]);
    await expect(web.client.call('compare', { session: SessionId.parse('ses_other'), parts: [{ type: 'text', text: 'x' }], variants, client }, as)).rejects.toMatchObject({ status: 404 });
    // fewer than two variants is not a compare
    await expect(web.client.call('compare', { session: sessionId, parts: [{ type: 'text', text: 'x' }], variants: variants.slice(0, 1), client }, as)).rejects.toMatchObject({ status: 400 });
  });

  it('reads and chooses as the signed-in person', async () => {
    const asked: unknown[] = [];
    const { web, as, me } = await signedIn({
      chat: {
        compare: {
          view: (id, viewer) => { asked.push({ view: id, viewer }); return Promise.resolve(view(sessionId)); },
          choose: (input) => { asked.push(input); return Promise.resolve({ ...view(sessionId), chosen: input.variant }); },
        },
      },
    });
    expect(await web.client.call('compareView', { turn }, as)).toMatchObject({ turn, reserved: 0.5 });
    expect(await web.client.call('chooseVariant', { turn, variant: 1, adopt: true }, as)).toMatchObject({ chosen: 1 });
    expect(asked).toEqual([{ view: turn, viewer: me }, { turn, variant: 1, adopt: true, by: me }]);
  });
});
