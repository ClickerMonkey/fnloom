/**
 * The installable app, asked of Chrome itself: a hub started on a port of its own with a fresh data folder serves
 * http and https on that port, https with the certificate it made from its own authority (nothing set up). Chrome
 * trusts that authority's keys for the test (`--ignore-certificate-errors-spki-list`, the hub's authority and its
 * certificate), the way a phone that installed the authority does. Over https on this computer's network address,
 * the DevTools protocol reports no installability errors (`Page.getInstallabilityErrors`) and the manifest parses
 * clean (`Page.getAppManifest`); over plain http on the same address the page isn't secure, says so, and nothing can
 * install. Signed in, Settings › App offers Install app once Chrome offers its prompt. With the hub stopped, a page
 * load gets the offline page from the service worker.
 *
 *   npm run test:browser          (builds the web app first; HARNESS_BROWSER_NO_BUILD=true uses the dist there)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lanAddresses, wantedAddresses } from '../packages/hub/src/api/tls.ts';
import { waitFor } from '../scripts/hub-client.ts';

const settings = env({
  /** The throwaway hub's port (clear of the owner's stacks on 4300–4351). */
  HARNESS_BROWSER_PORT: z.number().int().min(1024).max(65535).default(4597),
  /** Use the web app already built in `packages/web/dist`. */
  HARNESS_BROWSER_NO_BUILD: z.boolean().default(false),
  HARNESS_BROWSER_HEADLESS: z.boolean().default(true),
}).parse();

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'packages', 'web');
const DIST = join(WEB, 'dist');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const PORT = settings.HARNESS_BROWSER_PORT;
const ADMIN = { email: 'install@harness.local', password: 'install-test-password' };
/** The address other devices use: this computer's first network address the hub's certificate covers, else loopback. */
const HOST = wantedAddresses('x', lanAddresses()).ips.find((ip) => ip !== '127.0.0.1' && ip !== '::1') ?? '127.0.0.1';
const HTTPS = `https://${HOST}:${String(PORT)}`;
const HTTP = `http://${HOST}:${String(PORT)}`;

let data = '';
let hub: ChildProcess | undefined;
let browser: Browser | undefined;
let output = '';

/** Start the throwaway hub and wait until it answers. */
async function startHub(): Promise<void> {
  const child = spawn(process.execPath, [TSX, join(ROOT, 'packages', 'hub', 'src', 'main.ts')], {
    // its own folder as the working one, so no .env of this checkout is read
    cwd: data, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HARNESS_PORT: String(PORT), HARNESS_HOST: '0.0.0.0', HARNESS_DATA: data, HARNESS_WEB_DIST: DIST, HARNESS_LOG_FILES: 'false',
      HARNESS_ADMIN_EMAIL: ADMIN.email, HARNESS_ADMIN_PASSWORD: ADMIN.password, HARNESS_PASSWORD_COST: '10',
    },
  });
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  hub = child;
  await waitFor('the hub to be ready', async () => ((await fetch(`http://127.0.0.1:${String(PORT)}/readyz`).catch(() => undefined))?.ok === true ? true : undefined), { timeout: 150_000 });
}

/**
 * Build the web app as a release, in a process of its own: under vitest `NODE_ENV` is `test`, and a build made in
 * here would think it is in development (and register the service worker from source).
 */
async function buildWeb(): Promise<void> {
  const child = spawn(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { cwd: WEB, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
  const code = await new Promise<number | null>((resolve) => { child.once('exit', resolve); });
  if (code !== 0) { throw new Error(`the web build failed (${String(code)})`); }
}

/** Wait until the service worker (registered when the app starts) controls the page. */
async function controlled(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 30_000 });
}

/** Stop the hub (and wait for it to go). */
async function stopHub(): Promise<void> {
  const child = hub;
  hub = undefined;
  if (child?.exitCode !== null || child.pid === undefined) { return; }
  const gone = new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); });
  child.kill();
  await gone;
}

/** The SHA-256 of a certificate's public key, as Chrome's SPKI list takes it. */
const spki = (pem: string): string => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

/** The certificate the hub's port presents over TLS (the first TLS connection makes it). */
const presented = (): Promise<string> => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false, servername: 'localhost' }, () => {
    const raw = socket.getPeerCertificate().raw;
    socket.end();
    resolve(new X509Certificate(raw).toString());
  });
  socket.on('error', reject);
});

/** What Chrome says about installing the page. */
async function installability(page: Page): Promise<{ errors: unknown[]; manifestErrors: unknown[]; manifest: string }> {
  const cdp = await page.createCDPSession();
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  const manifest = await cdp.send('Page.getAppManifest', {});
  await cdp.detach();
  return { errors: installabilityErrors, manifestErrors: manifest.errors, manifest: manifest.data ?? '' };
}

beforeAll(async () => {
  if (!settings.HARNESS_BROWSER_NO_BUILD || !existsSync(join(DIST, 'index.html'))) { await buildWeb(); }
  data = mkdtempSync(join(tmpdir(), 'harness-install-'));
  await startHub();
}, 400_000);

afterAll(async () => {
  await browser?.close();
  await stopHub();
  if (data !== '') { rmSync(data, { recursive: true, force: true }); }
});

describe('the installable app', () => {
  let ca = '';
  let leaf = '';

  it('serves https on the same port with a certificate from its own authority, and the authority to install', async () => {
    leaf = await presented();
    const authority = await fetch(`http://127.0.0.1:${String(PORT)}/harness-ca.pem`);
    expect(authority.status).toBe(200);
    ca = await authority.text();
    const caX = new X509Certificate(ca);
    const leafX = new X509Certificate(leaf);
    expect(caX.ca).toBe(true);
    expect(leafX.checkIssued(caX) && leafX.verify(caX.publicKey)).toBe(true);
    expect(leafX.checkIP(HOST)).toBe(HOST);
    expect(leafX.checkHost('localhost')).toBe('localhost');
    // plain http keeps working on the same port
    expect((await fetch(`http://127.0.0.1:${String(PORT)}/healthz`)).ok).toBe(true);
  });

  it('is installable over https, as Chrome reports it', async () => {
    browser = await puppeteer.launch({
      headless: settings.HARNESS_BROWSER_HEADLESS,
      // trust the hub's authority and certificate, as a phone that installed the authority does; fire the install
      // prompt without the usual engagement wait
      args: [`--ignore-certificate-errors-spki-list=${spki(ca)},${spki(leaf)}`, '--bypass-app-banner-engagement-checks'],
    });
    const page = await browser.newPage();
    await page.goto(`${HTTPS}/`, { waitUntil: 'networkidle0' });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await controlled(page);
    const report = await installability(page);
    console.info('installability', JSON.stringify({ url: HTTPS, errors: report.errors, manifestErrors: report.manifestErrors }));
    expect(report.errors).toEqual([]);
    expect(report.manifestErrors).toEqual([]);
    expect(JSON.parse(report.manifest)).toMatchObject({ name: 'Harness', display: 'standalone', start_url: '/' });
    // the live connection goes over wss on the same port
    const socket = await page.evaluate((url) => new Promise<string>((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.close(); resolve('open'); };
      ws.onerror = () => { resolve('error'); };
    }), `${HTTPS.replace('https', 'wss')}/ws`);
    expect(socket).toBe('open');
    await page.close();
  });

  it('says a plain http page on the network isn\'t secure, and nothing installs there', async () => {
    if (HOST === '127.0.0.1') { return; }
    const page = await requireBrowser().newPage();
    await page.goto(`${HTTP}/`, { waitUntil: 'networkidle0' });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    const report = await installability(page);
    console.info('installability over http', JSON.stringify(report.errors));
    expect(report.errors.length).toBeGreaterThan(0);
    await signIn(page, HTTP);
    await page.goto(`${HTTP}/settings/app`, { waitUntil: 'networkidle0' });
    expect(await page.$eval('[data-testid=install-card]', (card) => card.getAttribute('data-state'))).toBe('insecure');
    expect(await page.$eval('[data-testid=insecure-banner]', (banner) => banner.textContent)).toContain('can’t be installed');
    await page.close();
  });

  it('offers Install app in Settings and the account menu once Chrome offers its prompt', async () => {
    const page = await requireBrowser().newPage();
    await signIn(page, HTTPS);
    await page.goto(`${HTTPS}/settings/app`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid=install-card][data-state=ready]', { timeout: 30_000 });
    expect(await page.$eval('[data-testid=install-app]', (button) => button.textContent)).toContain('Install app');
    await page.click('[data-testid=user-menu]');
    await page.waitForSelector('::-p-text(Install app)');
    // the phone steps: the authority to download, and the secure address
    expect(await page.$eval('[data-testid=download-authority]', (link) => link.getAttribute('href'))).toBe('/harness-ca.crt');
    expect(await page.$$eval('[data-testid=https-link]', (links) => links.map((link) => link.textContent))).toContain(`${HTTPS}/`);
    await page.close();
  });

  it('shows the offline page when the hub can\'t be reached', async () => {
    const page = await requireBrowser().newPage();
    await page.goto(`${HTTPS}/chat`, { waitUntil: 'networkidle0' });
    await controlled(page);
    await stopHub();
    await page.reload({ waitUntil: 'load' });
    expect(await page.$eval('[data-testid=offline-page]', (main) => main.textContent)).toContain('Can\'t reach your hub');
    // the address stays the one asked for, so Try again asks for it again
    expect(page.url()).toBe(`${HTTPS}/chat`);
    await page.close();
  });
});

function requireBrowser(): Browser {
  if (browser === undefined) { throw new Error(`the browser didn't start; hub output:\n${output}`); }
  return browser;
}

/** Sign in as the test's admin. */
async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-in`, { waitUntil: 'networkidle0' });
  await page.type('input[name="username"]', ADMIN.email);
  await page.type('input[name="password"]', ADMIN.password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => undefined), page.keyboard.press('Enter')]);
  await waitFor('sign-in', async () => (new URL(page.url()).pathname.startsWith('/sign-in') ? undefined : true), { timeout: 30_000 });
}
