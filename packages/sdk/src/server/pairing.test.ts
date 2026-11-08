import { describe, expect, it } from 'vitest';
import { MAIN_INSTANCE, type Json } from '@harness/core';
import type { Log } from '../ctx.ts';
import { codeBanner, LogPairingDisplay, pairingDisplayFor, TerminalPairingDisplay, type PairingShown } from './pairing.ts';

/** A log that keeps its lines. */
function memoryLog(): Log & { lines: Array<[string, string, Record<string, Json> | undefined]> } {
  const lines: Array<[string, string, Record<string, Json> | undefined]> = [];
  return {
    lines,
    debug: (key, fields) => { lines.push(['debug', key, fields]); },
    info: (key, fields) => { lines.push(['info', key, fields]); },
    warn: (key, fields) => { lines.push(['warn', key, fields]); },
    error: (key, fields) => { lines.push(['error', key, fields]); },
  };
}

const pairing: PairingShown = { system: 'fs', instance: MAIN_INSTANCE, code: 'ABCD-1234', url: 'http://192.168.1.5:4300/pair/pai_1?code=ABCD-1234', expiresAt: 0 };

describe('showing a pairing', () => {
  it('logs the link and code', async () => {
    const log = memoryLog();
    await new LogPairingDisplay(log).show(pairing);
    expect(log.lines).toEqual([['warn', 'system.pairing', { system: 'fs', instance: 'main', code: 'ABCD-1234', url: pairing.url, expiresAt: 0 }]]);
  });

  it('prints a QR code of the link and the code in large letters, and logs them too', async () => {
    const log = memoryLog();
    const written: string[] = [];
    const asked: string[] = [];
    const display = new TerminalPairingDisplay({ log, write: (text) => { written.push(text); }, qr: (text) => { asked.push(text); return Promise.resolve('[QR]'); } });
    await display.show(pairing);
    expect(asked).toEqual([pairing.url]);
    const text = written.join('');
    expect(text).toContain('fs (main) is waiting to be paired');
    expect(text).toContain('[QR]');
    expect(text).toContain(`Open ${pairing.url}`);
    expect(text).toContain('A B C D - 1 2 3 4');
    expect(log.lines.map(([, key]) => key)).toEqual(['system.pairing']);
  });

  it('prints the link and code alone when there is no QR renderer, or it fails', async () => {
    for (const qr of [undefined, () => Promise.reject(new Error('too long'))]) {
      const written: string[] = [];
      await new TerminalPairingDisplay({ log: memoryLog(), write: (text) => { written.push(text); }, ...(qr === undefined ? {} : { qr }) }).show(pairing);
      expect(written.join('')).not.toContain('Scan this');
      expect(written.join('')).toContain('A B C D - 1 2 3 4');
    }
  });

  it('boxes the code', () => {
    expect(codeBanner('AB')).toBe('┌───────┐\n│  A B  │\n└───────┘');
  });

  it('draws QR codes only on a terminal unless told always or never', async () => {
    const options = { log: memoryLog(), write: () => undefined };
    expect(await pairingDisplayFor('auto', { ...options, tty: false })).toBeInstanceOf(LogPairingDisplay);
    expect(await pairingDisplayFor('never', { ...options, tty: true })).toBeInstanceOf(LogPairingDisplay);
    expect(await pairingDisplayFor('auto', { ...options, tty: true })).toBeInstanceOf(TerminalPairingDisplay);
    expect(await pairingDisplayFor('always', { ...options, tty: false })).toBeInstanceOf(TerminalPairingDisplay);
  });
});
