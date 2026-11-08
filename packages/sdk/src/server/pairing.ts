/**
 * Showing a pairing to the person who approves it. While a new system waits for approval the SDK hands the hub's
 * pairing reply to a `PairingDisplay`: `TerminalPairingDisplay` prints a QR code of the pairing link (scan it with a
 * phone, sign in, set the config and pair) with the code in large letters; `LogPairingDisplay` only logs them, for
 * processes nobody watches. Which one a host uses follows `HARNESS_PAIRING_QR`.
 */
import type { InstanceName, Timestamp } from '@harness/core';
import QRCode from 'qrcode';
import type { Log } from '../ctx.ts';

/** What is shown while a system waits for its pairing to be approved. */
export interface PairingShown {
  readonly system: string;
  readonly instance: InstanceName;
  /** The code the admin compares with the one the hub shows. */
  readonly code: string;
  /** Where the admin approves it: the hub's `/pair/:pairing` page. */
  readonly url: string;
  readonly expiresAt: Timestamp;
}

/** Shows a pending pairing. Injected into the host, so tests capture what was shown. */
export interface PairingDisplay {
  show(pairing: PairingShown): Promise<void>;
}

/** When the terminal display draws a QR code: on a terminal (`auto`), always, or never (log only). */
export const PAIRING_QR_MODES = ['auto', 'always', 'never'] as const;
export type PairingQrMode = (typeof PAIRING_QR_MODES)[number];

/** Turns text into a QR code drawn with UTF-8 block characters. */
export type QrRenderer = (text: string) => Promise<string>;

/** Logs the pairing link and code: a structured `system.pairing` line. */
export class LogPairingDisplay implements PairingDisplay {
  readonly #log: Log;

  constructor(log: Log) {
    this.#log = log;
  }

  show(pairing: PairingShown): Promise<void> {
    this.#log.warn('system.pairing', { system: pairing.system, instance: pairing.instance, code: pairing.code, url: pairing.url, expiresAt: pairing.expiresAt });
    return Promise.resolve();
  }
}

/** The code with its letters spaced apart in a box, so it reads from across a room. */
export function codeBanner(code: string): string {
  const spaced = Array.from(code).join(' ');
  const line = '─'.repeat(spaced.length + 4);
  return [`┌${line}┐`, `│  ${spaced}  │`, `└${line}┘`].join('\n');
}

/**
 * Prints the pairing for a person at the terminal: a QR code of the link, the link, and the code in large letters, as
 * well as logging it. Without a QR renderer it prints the link and code alone.
 */
export class TerminalPairingDisplay implements PairingDisplay {
  readonly #log: LogPairingDisplay;
  readonly #write: (text: string) => void;
  readonly #qr: QrRenderer | undefined;

  constructor(options: { log: Log; write: (text: string) => void; qr?: QrRenderer }) {
    this.#log = new LogPairingDisplay(options.log);
    this.#write = options.write;
    this.#qr = options.qr;
  }

  async show(pairing: PairingShown): Promise<void> {
    await this.#log.show(pairing);
    const qr = this.#qr === undefined ? undefined : await this.#qr(pairing.url).catch(() => undefined);
    const until = new Date(pairing.expiresAt).toLocaleTimeString();
    this.#write([
      '',
      `${pairing.system} (${pairing.instance}) is waiting to be paired with the hub.`,
      ...(qr === undefined ? [] : ['Scan this to open the pairing page:', qr]),
      `Open ${pairing.url}`,
      'and check the code matches:',
      codeBanner(pairing.code),
      `The request lasts until ${until}.`,
      '',
    ].join('\n'));
  }
}

/** The `qrcode` package's terminal renderer: small UTF-8 blocks, so the code fits a terminal. */
export const terminalQr: QrRenderer = (text) => QRCode.toString(text, { type: 'terminal', small: true });

/**
 * The display a host uses: the terminal one when QR codes are on (`always`, or `auto` on a terminal), the log-only one
 * otherwise.
 */
export function pairingDisplayFor(mode: PairingQrMode, options: { log: Log; tty: boolean; write: (text: string) => void }): PairingDisplay {
  if (mode === 'never' || (mode === 'auto' && !options.tty)) { return new LogPairingDisplay(options.log); }
  return new TerminalPairingDisplay({ log: options.log, write: options.write, qr: terminalQr });
}
