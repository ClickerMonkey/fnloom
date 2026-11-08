import { describe, expect, it } from 'vitest';
import type { WsState, WsTransport } from '@ayepi/core/client';
import { watchRefusals } from './client.ts';

/** A socket that records what is sent and lets the test answer. */
function fakeSocket() {
  const sent: string[] = [];
  let listener: (frame: string) => void = () => undefined;
  const socket: WsTransport = {
    send: (frame) => { sent.push(frame); },
    onMessage: (cb) => { listener = cb; },
    onState: (_cb: (state: WsState) => void) => () => undefined,
    connect: () => undefined, close: () => undefined, state: 'open',
  };
  return { socket, sent, answer: (frame: object) => { listener(JSON.stringify(frame)); } };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe('watchRefusals', () => {
  it('sends a call the hub refused for its token once more after the tab refreshes, and the caller sees only the answer', async () => {
    const { socket, sent, answer } = fakeSocket();
    const seen: string[] = [];
    let recovered = 0;
    const ws = watchRefusals(socket, () => { recovered += 1; return Promise.resolve(true); });
    ws.onMessage((frame) => { seen.push(frame); });
    const call = JSON.stringify({ id: 'c1', type: 'sessions', data: {} });
    ws.send(call);
    answer({ id: 'c1', $status: 401, $error: 'sign in again' });
    await settle();
    expect(recovered).toBe(1);
    expect(sent).toEqual([call, call]);
    expect(seen).toEqual([]);
    answer({ id: 'c1', $status: 200, data: [] });
    expect(seen).toHaveLength(1);
  });

  it('passes the refusal on when the refresh fails, or when the call was already sent again', async () => {
    const { socket, answer } = fakeSocket();
    const seen: string[] = [];
    let signedIn = false;
    const ws = watchRefusals(socket, () => Promise.resolve(signedIn));
    ws.onMessage((frame) => { seen.push(frame); });
    ws.send(JSON.stringify({ id: 'c1', type: 'sessions', data: {} }));
    answer({ id: 'c1', $status: 401 });
    await settle();
    expect(seen).toHaveLength(1);
    signedIn = true;
    ws.send(JSON.stringify({ id: 'c2', type: 'sessions', data: {} }));
    answer({ id: 'c2', $status: 401 });
    await settle();
    answer({ id: 'c2', $status: 401 });
    await settle();
    expect(seen).toHaveLength(2);
  });

  it('never sends again a call that streamed items up', async () => {
    const { socket, sent, answer } = fakeSocket();
    const seen: string[] = [];
    const ws = watchRefusals(socket, () => Promise.resolve(true));
    ws.onMessage((frame) => { seen.push(frame); });
    ws.send(JSON.stringify({ id: 'c1', type: 'upload', data: {} }));
    ws.send(JSON.stringify({ id: 'c1', chunk: 'a' }));
    answer({ id: 'c1', $status: 401 });
    await settle();
    expect(sent).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });
});
